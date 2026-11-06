import boto3

cognito = boto3.client('cognito-identity', region_name='us-east-1')
identity = cognito.get_id(IdentityPoolId='us-east-1:4867a4ae-a34b-4871-81e6-32174e227a6a')
creds = cognito.get_credentials_for_identity(IdentityId=identity['IdentityId'])
s3 = boto3.client('s3', region_name='sa-east-1', aws_access_key_id=creds['Credentials']['AccessKeyId'], aws_secret_access_key=creds['Credentials']['SecretKey'], aws_session_token=creds['Credentials']['SessionToken'])

# Download the largest statement file for balance analysis
key = 'statements/059e21d6-4441-489d-95ea-dcc7411808f9.csv'
response = s3.get_object(Bucket='espressoapp-production', Key=key)
content = response['Body'].read().decode('utf-8', errors='ignore')

# Parse for balance information
lines = content.split('\n')

positive = []  # Recargas (saldo adicionado)
negative = []  # Saques/resgates (saldo retirado)
cards = {}  # Card-specific info

for line in lines[1:]:
    if not line.strip():
        continue
    parts = line.split(';')
    if len(parts) < 8:
        continue
    
    date = parts[0]
    name = parts[2].replace('"', '')
    card = parts[3].replace('"', '')
    value_str = parts[4]
    transaction_type = parts[7] if len(parts) > 7 else ''
    
    try:
        value = float(value_str.replace(',', '.'))
    except:
        continue
    
    # Track by card
    if card and card != '' and 'final' in card.lower():
        card_id = card.replace('final ', '')
        if card_id not in cards:
            cards[card_id] = {'positive': 0, 'negative': 0, 'count': 0}
        if value > 0:
            cards[card_id]['positive'] += value
        else:
            cards[card_id]['negative'] += abs(value)
        cards[card_id]['count'] += 1

# Print summary
print('=== CARD BALANCE SUMMARY ===')
print('-' * 60)
for card, data in sorted(cards.items(), key=lambda x: x[1]['positive'], reverse=True):
    net = data['positive'] - data['negative']
    print(f'Card {card}:')
    print(f'  Total Recargas: R$ {data["positive"]:.2f}')
    print(f'  Total Saques: R$ {data["negative"]:.2f}')
    print(f'  Saldo REDUTO: R$ {net:.2f}')
    print(f'  Transacoes: {data["count"]}')
    print()

# Find cards with highest balances
print('=== TOP 5 CARDS COM MAIOR SALDO ===')
sorted_cards = sorted(cards.items(), key=lambda x: (x[1]['positive'] - x[1]['negative']), reverse=True)
for i, (card, data) in enumerate(sorted_cards[:5]):
    net = data['positive'] - data['negative']
    print(f'{i+1}. Card {card}: R$ {net:.2f}')