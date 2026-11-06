import boto3

cognito = boto3.client('cognito-identity', region_name='us-east-1')
identity = cognito.get_id(IdentityPoolId='us-east-1:4867a4ae-a34b-4871-81e6-32174e227a6a')
creds = cognito.get_credentials_for_identity(IdentityId=identity['IdentityId'])
s3 = boto3.client('s3', region_name='sa-east-1', aws_access_key_id=creds['Credentials']['AccessKeyId'], aws_secret_access_key=creds['Credentials']['SecretKey'], aws_session_token=creds['Credentials']['SessionToken'])

response = s3.get_object(Bucket='espressoapp-production', Key='statements/059e21d6-4441-489d-95ea-dcc7411808f9.csv')
content = response['Body'].read().decode('utf-8', errors='ignore')

names = set()
cards = set()
values = []

lines = content.split('\n')
for line in lines[1:]:
    if not line.strip():
        continue
    parts = line.split(';')
    if len(parts) >= 6:
        name = parts[2].replace('"', '')
        card = parts[3].replace('"', '')
        value = parts[4]
        if name and name != '':
            names.add(name)
        if card and 'final' in card.lower():
            cards.add(card.replace('final ', ''))
        try:
            values.append(float(value.replace(',', '.')))
        except:
            pass

print('=== UNIQUE EMPLOYEES FOUND ===')
for n in sorted(names):
    print(n)
print('Total unique employees:', len(names))

print('\n=== CARD LAST 4 DIGITS ===')
for c in sorted(cards):
    print(c)
print('Total unique cards:', len(cards))

print('\n=== VALUE STATISTICS ===')
print('Total transactions:', len(values))
print('Min value:', min(values))
print('Max value:', max(values))
print('Sum of all values:', sum(values))