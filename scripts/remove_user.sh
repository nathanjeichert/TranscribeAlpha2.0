#!/bin/bash
#
# Remove a user from TranscribeAlpha
# Usage: ./scripts/remove_user.sh <username>
#
# Note: This removes the user's login but their transcripts remain in storage.
#

set -e

SECRET_NAME="transcribealpha-users"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ $# -lt 1 ]; then
    echo -e "${RED}Usage: $0 <username>${NC}"
    exit 1
fi

USERNAME="$1"

echo -e "${YELLOW}Removing user: ${USERNAME}${NC}"

# Check gcloud
if ! gcloud auth print-identity-token &> /dev/null 2>&1; then
    echo -e "${RED}Error: Not logged in to gcloud. Run: gcloud auth login${NC}"
    exit 1
fi

# Get current users
CURRENT_USERS=$(gcloud secrets versions access latest --secret="$SECRET_NAME" 2>/dev/null)

# Check if user exists
if ! echo "$CURRENT_USERS" | python3 -c "import sys, json; users = json.load(sys.stdin); exit(0 if any(u['username'] == '$USERNAME' for u in users.get('users', [])) else 1)" 2>/dev/null; then
    echo -e "${RED}Error: User '$USERNAME' not found${NC}"
    exit 1
fi

# Confirm
echo -e "${YELLOW}Are you sure you want to remove '$USERNAME'? (y/N)${NC}"
read -r CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Cancelled."
    exit 0
fi

# Remove user
NEW_USERS=$(echo "$CURRENT_USERS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
data['users'] = [u for u in data['users'] if u['username'] != '$USERNAME']
print(json.dumps(data, indent=2))
")

# Upload
TEMP_FILE=$(mktemp)
echo "$NEW_USERS" > "$TEMP_FILE"
gcloud secrets versions add "$SECRET_NAME" --data-file="$TEMP_FILE" --quiet
rm -f "$TEMP_FILE"

echo ""
echo -e "${GREEN}User '$USERNAME' removed successfully!${NC}"
echo ""
echo "Note: Their transcripts remain in Cloud Storage."
