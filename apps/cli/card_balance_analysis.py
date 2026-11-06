#!/usr/bin/env python3
import boto3
import json

cognito = boto3.client('cognito-identity', region_name='us-east-1')
identity = cognito.get_id(IdentityPoolId='us-east-1:4867a4ae-a34b-4871-81e6-32174e227a6a')
creds = cognito.get_credentials_for_identity(IdentityId=identity['IdentityId'])
s3 = boto3.client('s3', region_name='sa-east-1', aws_access_key_id=creds['Credentials']['AccessKeyId'], aws_secret_access_key=creds['Credentials']['SecretKey'], aws_session_token=creds['Credentials']['SessionToken'])

response = s3.get_object(Bucket='espressoapp-production', Key='statements/059e21d6-4441-489d-95ea-dcc7411808f9.csv')
content = response['Body'].read().decode('utf-8', errors='ignore')
lines = content.split('\n')

cards = {}

for line in lines[1:]:
    parts = line.split(';')
    if len(parts) < 8:
        continue
    
    name = parts[2].replace('"', '')
    card = parts[3].replace('"', '')
    value_str = parts[4]
    
    try:
        value = float(value_str.replace(',', '.'))
    except:
        continue
    
    if 'final' in card.lower():
        card_id = card.replace('final ', '')
        if card_id not in cards:
            cards[card_id] = {'names': set(), 'total_pos': 0, 'total_neg': 0, 'count': 0}
        
        if name:
            cards[card_id]['names'].add(name)
        
        if value > 0:
            cards[card_id]['total_pos'] += value
        else:
            cards[card_id]['total_neg'] += abs(value)
        cards[card_id]['count'] += 1

print('=== CARD BALANCE SUMMARY ===')
for card_id, data in sorted(cards.items(), key=lambda x: x[1]['total_pos'], reverse=True):
    net = data['total_pos'] - data['total_neg']
    names = ', '.join(data['names']) if data['names'] else 'N/A'
    print(f'Card {card_id}:')
    print(f'  Name: {names}')
    print(f'  Saldos Positivos: R$ {data["total_pos"]:.2f}')
    print(f'  Saldos Negativos: R$ {data["total_neg"]:.2f}')
    print(f'  SALDO TOTAL: R$ {net:.2f}')
    print(f'  Transacoes: {data["count"]}')
    print()

print('=== TOP 5 CARDS COM MAIOR SALDO ===')
sorted_cards = sorted(cards.items(), key=lambda x: (x[1]['total_pos'] - x[1]['total_neg']), reverse=True)[:5]
for i, (card_id, data) in enumerate(sorted_cards, 1):
    net = data['total_pos'] - data['total_neg']
    print(f'{i}. Card {card_id}: R$ {net:.2f}')

# Save JSON
output = {k: {'names': list(v['names']), 'total_pos': v['total_pos'], 'total_neg': v['total_neg'], 'net': v['total_pos'] - v['total_neg'], 'count': v['count']} for k, v in cards.items()}
with open('card_balances.json', 'w') as f:
    json.dump(output, f, indent=2)
print('\n[+] Saved to card_balances.json')