#!/bin/bash

echo "Setting up ngrok tunnel for TradingView webhooks in K3s"
echo "========================================================"
echo ""

# Check if ngrok authtoken is provided
if [ -z "$1" ]; then
    echo "Usage: ./setup-ngrok.sh <ngrok-authtoken>"
    echo ""
    echo "1. Sign up at https://ngrok.com"
    echo "2. Get your authtoken from https://dashboard.ngrok.com/auth"
    echo "3. Run: ./setup-ngrok.sh your-auth-token-here"
    exit 1
fi

NGROK_AUTHTOKEN=$1

echo "Creating ngrok secret..."
kubectl create secret generic ngrok-secret \
  --from-literal=authtoken=$NGROK_AUTHTOKEN \
  -n enclavetrade --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "Deploying enclavetrade with ngrok sidecar..."
kubectl apply -f - <<EOF
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
        livenessProbe:
          exec:
            command:
            - node
            - -e
            - "process.exit(0)"
          initialDelaySeconds: 30
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 10

      - name: ngrok
        image: ngrok/ngrok:alpine
        args:
        - "http"
        - "3000"
        env:
        - name: NGROK_AUTHTOKEN
          valueFrom:
            secretKeyRef:
              name: ngrok-secret
              key: authtoken
        ports:
        - containerPort: 4040
          name: ngrok-ui
EOF

echo ""
echo "Waiting for pods to start..."
sleep 10

echo ""
echo "Getting ngrok URL..."
kubectl port-forward -n enclavetrade deployment/enclavetrade 4040:4040 &
PF_PID=$!
sleep 3

echo ""
echo "ngrok tunnel URL:"
curl -s http://localhost:4040/api/tunnels | grep -o '"public_url":"[^"]*' | grep -o 'https://[^"]*' | head -1

echo ""
echo "Use this URL in TradingView webhooks: <URL>/webhook/tradingview"
echo ""
echo "To view ngrok dashboard: kubectl port-forward -n enclavetrade deployment/enclavetrade 4040:4040"
echo "Then visit: http://localhost:4040"

kill $PF_PID 2>/dev/null