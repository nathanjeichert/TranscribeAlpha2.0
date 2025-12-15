#!/bin/bash
#
# List all TranscribeAlpha users
# Usage: ./scripts/list_users.sh
#

SECRET_NAME="transcribealpha-users"

# Check if gcloud is available and logged in
if ! gcloud auth print-identity-token &> /dev/null 2>&1; then
    echo "Error: Not logged in to gcloud. Run: gcloud auth login"
    exit 1
fi

echo "TranscribeAlpha Users"
echo "====================="
echo ""

gcloud secrets versions access latest --secret="$SECRET_NAME" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
users = data.get('users', [])
if not users:
    print('No users found.')
else:
    for u in users:
        role = u.get('role', 'user')
        created = u.get('created_at', 'unknown')[:10]
        print(f\"  {u['username']:20} role: {role:8} created: {created}\")
    print()
    print(f'Total: {len(users)} user(s)')
"
