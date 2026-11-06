import boto3

# Get credentials
cognito = boto3.client('cognito-identity', region_name='us-east-1')
identity = cognito.get_id(IdentityPoolId='us-east-1:4867a4ae-a34b-4871-81e6-32174e227a6a')
creds = cognito.get_credentials_for_identity(IdentityId=identity['IdentityId'])
s3 = boto3.client('s3', region_name='sa-east-1', aws_access_key_id=creds['Credentials']['AccessKeyId'], aws_secret_access_key=creds['Credentials']['SecretKey'], aws_session_token=creds['Credentials']['SessionToken'])

# Download the largest statement file
response = s3.get_object(Bucket='espressoapp-production', Key='statements/059e21d6-4441-489d-95ea-dcc7411808f9.csv')
content = response['Body'].read().decode('utf-8', errors='ignore')
lines = content.split('\n')

# Dictionary to hold card balances
card_balances = {}
cardholders = set()

for line in lines[1:]:
    if not line.strip():
        continue
    
    parts = line.split(';')
    if len(parts) < 5:
        continue
    
    name = parts[2].replace('"', '')
    card = parts[3].replace('"', '')
    value_str = parts[4]
    
    try:
        value = float(value_str.replace(',', '.'))
    except:
        continue
    
    # Skip if it's not a card transaction (empty card field)
    if not card or card == '""' or 'final' not in card.lower():
        continue
    
    # Clean card number
    card_id = card.replace('final ', '')
    
    # Track cardholders
    if name:
        cardholders.add(name)
    
    # Initialize if not exists
    if card_id not in card_balances:
        card_balances[card_id] = {'positive': 0, 'negative': 0, 'holder': name if name else 'N/A', 'transactions': 0}
    
    # Add to balance
    if value > 0:
        card_balances[card_id]['positive'] += value
    else:
        card_balances[card_id]['negative'] += abs(value)
    
    card_balances[card_id]['transactions'] += 1

# Print results
print('='*80)
print('CARD BALANCE ANALYSIS - ESPRESSO APP')
print('='*80)
print('')

print('CARDHOLDERS IDENTIFIED:')
for name in sorted(cardholders):
    print('  - ' + name)
print('')
print('Total Unique Cardholders: ' + str(len(cardholders)))
print('')

print('CARD BALANCES:')
print('-'*80)

# Sort by net balance (descending)
sorted_cards = sorted(card_balances.items(), key=lambda x: x[1]['positive'] - x[1]['negative'], reverse=True)

for card_id, data in sorted_cards:
    net = data['positive'] - data['negative']
    print('Card ' + card_id + ':')
    print('  Holder: ' + data['holder'])
    print('  Total Deposits: R$ ' + str(round(data['positive'], 2)))
    print('  Total Withdrawals: R$ ' + str(round(data['negative'], 2)))
    print('  NET BALANCE: R$ ' + str(round(net, 2)))
    print('  Transactions: ' + str(data['transactions']))
    print('')

print('='*80)
print('SUMMARY')
print('='*80)
total_balance = sum(d['positive'] - d['negative'] for d in card_balances.values())
print('Total Cards Analyzed: ' + str(len(card_balances)))
print('Total Positive Balance: R$ ' + str(round(sum(d['positive'] for d in card_balances.values()), 2)))
print('Total Negative Balance: R$ ' + str(round(sum(d['negative'] for d in card_balances.values()), 2)))
print('NET TOTAL BALANCE: R$ ' + str(round(total_balance, 2)))