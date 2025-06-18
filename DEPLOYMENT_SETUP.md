# 🚀 Automatic Deployment Setup

## ✅ **Completed Steps:**
- ✅ APIs enabled (Cloud Build, Cloud Run, Container Registry)
- ✅ IAM permissions granted to Cloud Build service account
- ✅ cloudbuild.yaml configuration created
- ✅ Repository contains all necessary files

## 🔧 **Manual Setup Required:**

### **1. Connect GitHub Repository to Cloud Build**

Go to: https://console.cloud.google.com/cloud-build/triggers

1. Click **"Create Trigger"**
2. Select **"GitHub (Cloud Build GitHub App)"**
3. Click **"Connect Repository"**
4. Authenticate with GitHub and authorize Google Cloud Build
5. Select repository: **"nathanjeichert/TranscribeAlpha2.0"**
6. Click **"Connect"**

### **2. Configure the Build Trigger**

**Trigger Settings:**
- **Name:** `transcribealpha-auto-deploy`
- **Description:** `Auto-deploy TranscribeAlpha on master push`
- **Event:** Push to a branch
- **Source:** Repository: `nathanjeichert/TranscribeAlpha2.0`
- **Branch:** `^master$`

**Configuration:**
- **Type:** Cloud Build configuration file (yaml or json)
- **Location:** `cloudbuild.yaml`

**Substitution Variables:**
- Variable: `_GEMINI_API_KEY`
- Value: `AIzaSyBzSWIuZdjXtG7A8ibEB2CMiEaQt4EsbjI`

### **3. Advanced Settings (Optional)**
- **Service Account:** Default Cloud Build service account
- **Timeout:** 20 minutes (1200s)
- **Machine Type:** e2-highcpu-8

### **4. Test the Setup**

After creating the trigger:
1. Make a small change to your repository (like updating README.md)
2. Push to master branch
3. Go to Cloud Build → History to see the build progress
4. Check your service at: https://transcribealpha-426129655444.us-central1.run.app

## 🎯 **Expected Deployment Flow:**

```
GitHub Push → Cloud Build Trigger → Docker Build → Container Registry → Cloud Run Deploy
```

1. **Push to master** triggers the build
2. **Docker image** is built from your Dockerfile
3. **Container** is pushed to Google Container Registry
4. **Cloud Run service** is updated automatically
5. **Environment variables** (API key) are set during deployment

## 🔍 **Monitoring Deployments:**

- **Build History:** https://console.cloud.google.com/cloud-build/builds
- **Cloud Run Service:** https://console.cloud.google.com/run/detail/us-central1/transcribealpha
- **Container Images:** https://console.cloud.google.com/gcr/images/transciption-377723

## 🚨 **Troubleshooting:**

If builds fail:
1. Check Cloud Build logs in the console
2. Verify all APIs are enabled
3. Ensure service account has proper permissions
4. Check that Dockerfile and cloudbuild.yaml are valid

## 🎉 **Success Indicators:**

- ✅ Trigger shows "Connected" status
- ✅ Push to master triggers automatic build
- ✅ Build completes successfully (green checkmark)
- ✅ Cloud Run service updates automatically
- ✅ New features are live at your URL