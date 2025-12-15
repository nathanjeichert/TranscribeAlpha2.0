#!/bin/bash
#
# Add a new user to TranscribeAlpha
# Usage: ./scripts/add_user.sh <username> <password> [role]
#
# Example:
#   ./scripts/add_user.sh JohnDoe mypassword123
#   ./scripts/add_user.sh AdminUser adminpass admin
#

set -e

SECRET_NAME="transcribealpha-users"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check arguments
if [ $# -lt 2 ]; then
    echo -e "${RED}Usage: $0 <username> <password> [role]${NC}"
    echo ""
    echo "Arguments:"
    echo "  username  - The username for the new account"
    echo "  password  - The password for the new account"
    echo "  role      - Optional: 'admin' or 'user' (default: user)"
    echo ""
    echo "Example:"
    echo "  $0 JohnDoe mypassword123"
    echo "  $0 AdminUser adminpass admin"
    exit 1
fi

USERNAME="$1"
PASSWORD="$2"
ROLE="${3:-user}"

echo -e "${YELLOW}Adding user: ${USERNAME} (role: ${ROLE})${NC}"

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

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}Error: python3 is not installed${NC}"
    exit 1
fi

# Check if passlib is installed
if ! python3 -c "from passlib.hash import bcrypt" 2>/dev/null; then
    echo -e "${YELLOW}Installing passlib...${NC}"
    pip3 install passlib[bcrypt] --quiet
fi

# Generate password hash
echo "Generating password hash..."
PASSWORD_HASH=$(python3 -c "from passlib.hash import bcrypt; print(bcrypt.hash('$PASSWORD'))")

if [ -z "$PASSWORD_HASH" ]; then
    echo -e "${RED}Error: Failed to generate password hash${NC}"
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

# Add new user to JSON
echo "Adding user to configuration..."
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

NEW_USERS=$(echo "$CURRENT_USERS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
data['users'].append({
    'username': '$USERNAME',
    'password_hash': '$PASSWORD_HASH',
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
echo -e "${GREEN}User '$USERNAME' added successfully!${NC}"
echo ""
echo "Note: Changes take effect within 5 minutes (cache refresh)."
echo "To apply immediately, redeploy the Cloud Run service."
