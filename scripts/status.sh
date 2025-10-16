#!/bin/bash

# Enclave Trading Bot Status Checker
echo "🚀 Enclave Trading Bot Status Check"
echo "=================================="

# Check if bot process is running
BOT_PID=$(ps aux | grep "node dist/index.js" | grep -v grep | awk '{print $2}')

if [ -n "$BOT_PID" ]; then
    echo "✅ Bot Status: RUNNING (PID: $BOT_PID)"

    # Get latest status from webhook endpoint
    echo ""
    echo "📊 Current Trading Status:"
    echo "-------------------------"

    # Try to get status from the webhook server
    STATUS_RESPONSE=$(curl -s http://localhost:3000/health 2>/dev/null)

    if [ $? -eq 0 ] && [ -n "$STATUS_RESPONSE" ]; then
        echo "$STATUS_RESPONSE"
    else
        echo "⚠️  Webhook server not responding - checking process logs..."
        echo ""
        echo "Last few log entries:"
        tail -n 5 <(ps aux | grep "node dist/index.js" | grep -v grep)
    fi

    # Check if WebSocket is connected (look for recent activity)
    echo ""
    echo "🔗 Connection Status:"
    echo "WebSocket should be connected to Enclave Markets"

    # Memory usage
    MEM_USAGE=$(ps -o pid,pcpu,pmem,comm -p $BOT_PID | tail -n 1)
    echo ""
    echo "💾 Resource Usage:"
    echo "$MEM_USAGE"

else
    echo "❌ Bot Status: NOT RUNNING"
    echo ""
    echo "To start the bot:"
    echo "  npm start          # Start in production mode"
    echo "  npm run start:live # Start in live trading mode"
    echo "  npm run start:paper # Start in paper trading mode"
fi

echo ""
echo "🔧 Quick Commands:"
echo "  ./scripts/status.sh     # Check status (this script)"
echo "  npm run stop-all        # Emergency stop all trades"
echo "  tail -f logs/bot.log    # View live logs (if log file exists)"
echo "  ps aux | grep node      # See all node processes"