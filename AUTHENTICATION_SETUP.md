# TranscribeAlpha Authentication - Admin Guide

Quick reference for managing user accounts. Users stay logged in permanently until they click "Sign Out".

---

## Initial Setup (One-Time)

### 1. Generate a JWT Secret Key

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(64))"
```

Save this key - you'll need it for Cloud Build.

### 2. Create Password Hashes

```bash
pip install bcrypt

# For each user, run:
python3 -c "import bcrypt; print(bcrypt.hashpw('YOUR_PASSWORD_HERE'.encode(), bcrypt.gensalt()).decode())"
```

### 3. Create users.json

```json
{
  "users": [
    {
      "username": "VerdictGroup",
      "password_hash": "$2b$12$YOUR_HASH_HERE",
      "role": "admin",
      "created_at": "2025-01-01T00:00:00Z"
    },
    {
      "username": "Admin",
      "password_hash": "$2b$12$YOUR_HASH_HERE",
      "role": "admin",
      "created_at": "2025-01-01T00:00:00Z"
    }
  ]
}
```

### 4. Upload to Secret Manager

```bash
# Enable API (first time only)
gcloud services enable secretmanager.googleapis.com

# Create the secret
gcloud secrets create transcribealpha-users --data-file=users.json --replication-policy="automatic"

# Grant Cloud Run access (get project number first)
gcloud projects describe YOUR_PROJECT_ID --format="value(projectNumber)"

gcloud secrets add-iam-policy-binding transcribealpha-users \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 5. Add JWT_SECRET_KEY to Cloud Build

Go to **Cloud Console** > **Cloud Build** > **Triggers** > Edit your trigger

Add substitution variable:
- `_JWT_SECRET_KEY`: (paste your generated key)

---

## Common Admin Tasks

### Add a New User

```bash
# 1. Generate password hash
python3 -c "import bcrypt; print(bcrypt.hashpw('new_password'.encode(), bcrypt.gensalt()).decode())"

# 2. Add to users.json
{
  "username": "NewUser",
  "password_hash": "$2b$12$NEW_HASH",
  "role": "user",
  "created_at": "2025-01-01T00:00:00Z"
}

# 3. Update Secret Manager
gcloud secrets versions add transcribealpha-users --data-file=users.json
```

Wait 5 minutes for cache to refresh (or redeploy).

### Change a Password

```bash
# 1. Generate new hash
python3 -c "import bcrypt; print(bcrypt.hashpw('new_password'.encode(), bcrypt.gensalt()).decode())"

# 2. Update the password_hash in users.json

# 3. Upload new version
gcloud secrets versions add transcribealpha-users --data-file=users.json
```

### Remove a User

1. Delete the user object from `users.json`
2. Run: `gcloud secrets versions add transcribealpha-users --data-file=users.json`

### View Current Users

```bash
gcloud secrets versions access latest --secret=transcribealpha-users
```

---

## Migrate Existing Transcripts

One-time migration to assign existing transcripts to a user:

```bash
# Preview changes
python3 scripts/migrate_existing_transcripts.py --dry-run

# Apply
python3 scripts/migrate_existing_transcripts.py --user-id VerdictGroup
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Incorrect username or password" | Verify hash is correct in Secret Manager |
| "Could not validate credentials" | Check JWT_SECRET_KEY in Cloud Build trigger |
| Users see each other's transcripts | Run migration script to set user_id |
| Changes not taking effect | Wait 5 min for cache, or redeploy |

---

## Quick Commands Reference

```bash
# Generate password hash
python3 -c "import bcrypt; print(bcrypt.hashpw('password'.encode(), bcrypt.gensalt()).decode())"

# Generate JWT secret
python3 -c "import secrets; print(secrets.token_urlsafe(64))"

# Update users secret
gcloud secrets versions add transcribealpha-users --data-file=users.json

# View users secret
gcloud secrets versions access latest --secret=transcribealpha-users

# Run migration
python3 scripts/migrate_existing_transcripts.py --user-id USERNAME
```
