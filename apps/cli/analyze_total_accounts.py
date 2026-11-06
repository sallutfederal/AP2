import boto3
import json

# Get credentials
cognito = boto3.client('cognito-identity', region_name='us-east-1')
identity = cognito.get_id(IdentityPoolId='us-east-1:4867a4ae-a34b-4871-81e6-32174e227a6a')
creds = cognito.get_credentials_for_identity(IdentityId=identity['IdentityId'])
s3 = boto3.client('s3', region_name='sa-east-1', aws_access_key_id=creds['Credentials']['AccessKeyId'], aws_secret_access_key=creds['Credentials']['SecretKey'], aws_session_token=creds['Credentials']['SessionToken'])

# Check contatos_consolidados.csv for total records
print('[*] Analyzing contatos_consolidados.csv for total account count...')
try:
    response = s3.get_object(Bucket='espressoapp-production', Key='contatos_consolidados.csv')
    content = response['Body'].read().decode('utf-8', errors='ignore')
    lines = content.split('\n')
    
    # Count non-empty lines (excluding header if present)
    total_records = len([l for l in lines if l.strip() and not l.startswith('nome')])
    
    print('[+] Total records in contatos_consolidados.csv: ' + str(total_records))
    print('[+] Total accounts/users: approximately ' + str(total_records))
    
except Exception as e:
    print('[-] Error processing contatos file: ' + str(e))

# Check statements for unique cardholders
print('')
print('[*] Analyzing statements for unique cardholders...')
try:
    response = s3.get_object(Bucket='espressoapp-production', Key='statements/059e21d6-4441-489d-95ea-dcc7411808f9.csv')
    content = response['Body'].read().decode('utf-8', errors='ignore')
    lines = content.split('\n')
    
    names = set()
    for line in lines[1:]:
        parts = line.split(';')
        if len(parts) >= 3:
            name = parts[2].replace('"', '')
            if name and 'final' not in name:
                names.add(name)
    
    print('[+] Unique cardholders in statements: ' + str(len(names)))
    for n in sorted(names):
        print('   - ' + n)
        
except Exception as e:
    print('[-] Error processing statements: ' + str(e))