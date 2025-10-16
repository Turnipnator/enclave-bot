#!/bin/bash

echo "Setting up Cloudflare Tunnel for TradingView webhooks"
echo "====================================================="
echo ""
echo "Prerequisites:"
echo "1. Cloudflare account with a domain"
echo "2. cloudflared CLI installed locally"
echo ""

if ! command -v cloudflared &> /dev/null; then
    echo "cloudflared not found. Install with: brew install cloudflared"
    exit 1
fi

echo "Step 1: Login to Cloudflare"
cloudflared tunnel login

echo ""
echo "Step 2: Create tunnel"
TUNNEL_NAME="enclavetrade-$(date +%s)"
cloudflared tunnel create $TUNNEL_NAME

echo ""
echo "Step 3: Get tunnel credentials"
TUNNEL_ID=$(cloudflared tunnel list | grep $TUNNEL_NAME | awk '{print $1}')
TUNNEL_CRED_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"

echo "Tunnel ID: $TUNNEL_ID"

echo ""
echo "Step 4: Create Kubernetes secret from tunnel credentials"
kubectl create secret generic cloudflare-tunnel \
  --from-file=credentials.json=$TUNNEL_CRED_FILE \
  -n enclavetrade --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "Step 5: Deploy with Cloudflare tunnel sidecar"
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: cloudflared-config
  namespace: enclavetrade
data:
  config.yaml: |
    tunnel: $TUNNEL_ID
    credentials-file: /etc/cloudflared/credentials.json
    ingress:
      - service: http://localhost:3000
    no-autoupdate: true
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: enclavetrade
  namespace: enclavetrade
spec:
  replicas: 1
  selector:
    matchLabels:
      app: enclavetrade
  template:
    metadata:
      labels:
        app: enclavetrade
    spec:
      containers:
      - name: enclavetrade
        image: registry.homelab.local:5000/enclavetrade:latest
        imagePullPolicy: Always
        ports:
        - containerPort: 3000
          name: webhook
        envFrom:
        - secretRef:
            name: enclavetrade-secrets
        env:
        - name: NODE_ENV
          value: "production"
        - name: WEBHOOK_PORT
          value: "3000"
        - name: ENABLE_WEBHOOKS
          value: "true"
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"

      - name: cloudflared
        image: cloudflare/cloudflared:latest
        args:
        - tunnel
        - --config
        - /etc/cloudflared/config.yaml
        - --no-autoupdate
        - run
        volumeMounts:
        - name: config
          mountPath: /etc/cloudflared/config.yaml
          subPath: config.yaml
        - name: credentials
          mountPath: /etc/cloudflared/credentials.json
          subPath: credentials.json

      volumes:
      - name: config
        configMap:
          name: cloudflared-config
      - name: credentials
        secret:
          secretName: cloudflare-tunnel
EOF

echo ""
echo "Step 6: Configure DNS"
echo "Run this command to route your subdomain to the tunnel:"
echo ""
echo "cloudflared tunnel route dns $TUNNEL_NAME bot.yourdomain.com"
echo ""
echo "Replace 'bot.yourdomain.com' with your actual subdomain"
echo ""
echo "Your webhook URL will be: https://bot.yourdomain.com/webhook/tradingview"