import boto3
import json

# Credenciais Cognito
cognito = boto3.client('cognito-identity', region_name='us-east-1')
identity = cognito.get_id(IdentityPoolId='us-east-1:4867a4ae-a34b-4871-81e6-32174e227a6a')
creds = cognito.get_credentials_for_identity(IdentityId=identity['IdentityId'])
s3 = boto3.client('s3', region_name='sa-east-1', aws_access_key_id=creds['Credentials']['AccessKeyId'], aws_secret_access_key=creds['Credentials']['SecretKey'], aws_session_token=creds['Credentials']['SessionToken'])

# Search for files that might contain credentials
prefixes_to_check = ['glue/scripts/', 'redshift/', 'config/', 'scripts/', 'env/', 'secrets/', 'data/']

print('[*] Searching for credential files in espressoapp-production...')
found_keys = []

for prefix in prefixes_to_check:
    try:
        resp = s3.list_objects_v2(Bucket='espressoapp-production', Prefix=prefix, MaxKeys=20)
        if 'Contents' in resp:
            for obj in resp['Contents']:
                key = obj['Key']
                found_keys.append(key)
                if 'glue' in key.lower():
                    print('[GLUE SCRIPT] ' + key)
    except Exception as e:
        pass

print('')
print('[*] Found ' + str(len(found_keys)) + ' files')

# Now check the Glue bucket for credentials
print('')
print('[*] Checking aws-glue-assets bucket for credentials...')
try:
    resp = s3.list_objects_v2(Bucket='espressoapp-production', Prefix='glue/', MaxKeys=10)
    if 'Contents' in resp:
        for obj in resp['Contents']:
            print('  - ' + obj['Key'])
except Exception as e:
    print('  Error: ' + str(e))