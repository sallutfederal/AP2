import boto3

# Get credentials
cognito = boto3.client('cognito-identity', region_name='us-east-1')
identity = cognito.get_id(IdentityPoolId='us-east-1:4867a4ae-a34b-4871-81e6-32174e227a6a')
creds = cognito.get_credentials_for_identity(IdentityId=identity['IdentityId'])
s3 = boto3.client('s3', region_name='sa-east-1', aws_access_key_id=creds['Credentials']['AccessKeyId'], aws_secret_access_key=creds['Credentials']['SecretKey'], aws_session_token=creds['Credentials']['SessionToken'])

# Search for files that might contain user data
print('[*] Searching for user data files...')

buckets = ['espressoapp-production', 'espressoapp-staging']
user_file_keywords = ['user', 'contato', 'pessoa', 'cliente', 'client', 'contact', 'account', 'empresa', 'company', 'cadastro', 'register']

for bucket in buckets:
    try:
        print('')
        print('=== Bucket: ' + bucket + ' ===')
        resp = s3.list_objects_v2(Bucket=bucket, MaxKeys=1000)
        if 'Contents' in resp:
            for obj in resp['Contents']:
                key = obj['Key']
                size = obj['Size']
                for keyword in user_file_keywords:
                    if keyword in key.lower():
                        print('  [USER FILE] ' + key + ' (' + str(size) + ' bytes)')
                        break
    except Exception as e:
        print('  Error: ' + str(e))