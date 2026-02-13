#!/bin/bash
#
# Invite a new user to TranscribeAlpha (pending registration)
# Usage: ./scripts/invite_user.sh <username> [role]
#
# This creates a user entry with status "pending" and no password.
# The user must complete registration in the app to set their password.
#
# Example:
#   ./scripts/invite_user.sh JohnDoe
#   ./scripts/invite_user.sh AdminUser admin
#

set -e

SECRET_NAME="transcribealpha-users"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check arguments
if [ $# -lt 1 ]; then
    echo -e "${RED}Usage: $0 <username> [role]${NC}"
    echo ""
    echo "Arguments:"
    echo "  username  - The username for the new account"
    echo "  role      - Optional: 'admin' or 'user' (default: user)"
    echo ""
    echo "Example:"
    echo "  $0 JohnDoe"
    echo "  $0 AdminUser admin"
    echo ""
    echo "The user will need to complete registration in the app."
    exit 1
fi

USERNAME="$1"
ROLE="${2:-user}"

echo -e "${YELLOW}Inviting user: ${USERNAME} (role: ${ROLE})${NC}"

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}Error: gcloud CLI is not installed${NC}"
    echo "Install it from: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check if logged in to gcloud
if ! gcloud auth print-identity-token &> /dev/null; then
    echo -e "${RED}Error: Not logged in to gcloud${NC}"
    echo "Run: gcloud auth login"
    exit 1
fi

# Get current users from Secret Manager
echo "Fetching current users from Secret Manager..."
CURRENT_USERS=$(gcloud secrets versions access latest --secret="$SECRET_NAME" 2>/dev/null || echo '{"users":[]}')

# Check if user already exists
if echo "$CURRENT_USERS" | python3 -c "import sys, json; users = json.load(sys.stdin); exit(0 if any(u['username'] == '$USERNAME' for u in users.get('users', [])) else 1)" 2>/dev/null; then
    echo -e "${RED}Error: User '$USERNAME' already exists${NC}"
    exit 1
fi

# Add new pending user to JSON
echo "Adding pending user to configuration..."
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

NEW_USERS=$(echo "$CURRENT_USERS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
data['users'].append({
    'username': '$USERNAME',
    'password_hash': '',
    'status': 'pending',
    'role': '$ROLE',
    'created_at': '$TIMESTAMP'
})
print(json.dumps(data, indent=2))
")

# Save to temp file and upload
TEMP_FILE=$(mktemp)
echo "$NEW_USERS" > "$TEMP_FILE"

echo "Uploading to Secret Manager..."
gcloud secrets versions add "$SECRET_NAME" --data-file="$TEMP_FILE" --quiet

# Cleanup
rm -f "$TEMP_FILE"

echo ""
echo -e "${GREEN}User '$USERNAME' invited successfully!${NC}"
echo ""
echo "Tell them to open TranscribeAlpha and click 'Register' to set their password."
echo "Note: Changes take effect within 5 minutes (cache refresh)."
echo "To apply immediately, redeploy the Cloud Run service."
