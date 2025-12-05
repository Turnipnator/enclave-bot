# Enclave Trading Bot - Contabo VPS Deployment Guide

Complete guide to deploying your trading bot to your Contabo VPS running Ubuntu 24.04.3 LTS.

## Prerequisites

- Contabo VPS with Ubuntu 24.04.3 LTS
- SSH access to your VPS
- GitHub repository: https://github.com/Turnipnator/enclave-bot
- Enclave API credentials
- Telegram bot token and chat ID

## Quick Deploy (5 Minutes)

### 1. Connect to Your VPS

```bash
ssh root@your-contabo-ip
```

### 2. Install Git (if not installed)

```bash
apt update
apt install -y git
```

### 3. Clone Your Repository

```bash
cd /opt
git clone https://github.com/Turnipnator/enclave-bot.git
cd enclave-bot
```

### 4. Configure Environment Variables

Create your `.env` file with your credentials:

```bash
cp .env.example .env
nano .env
```

**Important:** Update these values in `.env`:

```bash
# Enclave API - YOUR ACTUAL CREDENTIALS
ENCLAVE_API_KEY=your_actual_api_key
ENCLAVE_API_SECRET=your_actual_api_secret
ENCLAVE_ENV=PROD
ENCLAVE_SUBACCOUNT=botman

# Trading Configuration
TRADING_MODE=live  # Change from 'paper' to 'live' for real trading

# Telegram Bot - YOUR ACTUAL CREDENTIALS
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here
TELEGRAM_ENABLED=true
```

Save and exit (Ctrl+X, then Y, then Enter).

### 5. Run the Deployment Script

```bash
chmod +x deploy.sh
./deploy.sh
```

The script will:
- Install Docker and Docker Compose (if needed)
- Build the bot image
- Start the container
- Show you the bot status

### 6. Verify Deployment

Check bot logs:

```bash
docker compose logs -f enclave-bot
```

You should see:
- ✅ "Telegram bot initialized successfully with command handlers"
- ✅ "Trading bot started successfully"
- ✅ Telegram notification: "Bot Started" on your phone

Press Ctrl+C to exit logs.

## Testing Your Bot

### Test Telegram Commands

Open Telegram and message your bot:

```
/status    - Check bot status and balance
/daily     - View daily P&L
/weekly    - View weekly performance
/alltime   - View all-time statistics
```

### Monitor Bot Activity

View live logs:
```bash
docker compose logs -f enclave-bot
```

Check bot status:
```bash
docker compose ps
```

View resource usage:
```bash
docker stats enclave-trading-bot
```

## Managing Your Bot

### Stop the Bot

```bash
cd /opt/enclave-bot
docker compose down
```

### Restart the Bot

```bash
cd /opt/enclave-bot
docker compose restart
```

### Update Bot Code

```bash
cd /opt/enclave-bot
git pull
docker compose down
docker compose build --no-cache
docker compose up -d
```

### View Recent Logs

```bash
docker compose logs --tail=100 enclave-bot
```

### Export Logs

```bash
docker compose logs enclave-bot > bot-logs-$(date +%Y%m%d).txt
```

## Auto-Start on VPS Reboot

Docker Compose is configured with `restart: unless-stopped`, so the bot will automatically restart if:
- The VPS reboots
- The bot crashes
- Docker daemon restarts

To disable auto-restart:
```bash
docker compose down
```

To enable auto-restart:
```bash
docker compose up -d
```

## Firewall Configuration (Optional)

If you enable webhooks for TradingView alerts:

```bash
# Allow webhook port
ufw allow 3000/tcp

# Check firewall status
ufw status
```

## Monitoring & Maintenance

### Daily Checks

1. **Check Balance**: `/status` in Telegram
2. **Review P&L**: `/daily` in Telegram
3. **Monitor Positions**: Check open positions in `/status`

### Weekly Maintenance

1. **Update Bot**: `git pull && docker compose up -d --build`
2. **Review Performance**: `/weekly` in Telegram
3. **Check Logs**: `docker compose logs --tail=500 enclave-bot`

### Monthly Tasks

1. **Backup Logs**: Export logs to local machine
2. **Review Strategy**: Analyze win rate and adjust parameters if needed
3. **Update Dependencies**: `docker compose build --no-cache`

## Troubleshooting

### Bot Not Starting

Check logs:
```bash
docker compose logs enclave-bot
```

Common issues:
- **Missing .env file**: Copy from `.env.example`
- **Invalid API credentials**: Check your Enclave API key/secret
- **Port already in use**: Change `WEBHOOK_PORT` in `.env`

### Telegram Not Working

1. Verify bot token and chat ID in `.env`
2. Check bot logs for errors: `docker compose logs | grep Telegram`
3. Test with `/start` command in Telegram

### Bot Crashes

View crash logs:
```bash
docker compose logs --tail=200 enclave-bot
```

Restart with fresh logs:
```bash
docker compose restart
```

### Out of Memory

Check memory usage:
```bash
free -h
docker stats
```

If memory is low, reduce `MAX_POSITIONS` in `.env`:
```bash
MAX_POSITIONS=2
```

Then restart:
```bash
docker compose restart
```

## Security Best Practices

1. **Never commit .env to Git**
   - Already in `.gitignore`
   - Contains API keys and secrets

2. **Use strong SSH keys**
   ```bash
   ssh-keygen -t ed25519
   ```

3. **Enable firewall**
   ```bash
   ufw enable
   ufw allow 22/tcp  # SSH
   ufw allow 3000/tcp  # Webhooks (optional)
   ```

4. **Keep system updated**
   ```bash
   apt update && apt upgrade -y
   ```

5. **Monitor bot activity**
   - Check Telegram notifications daily
   - Review logs weekly
   - Set up daily P&L alerts

## Production Checklist

Before going live with real funds:

- [ ] Bot running successfully on VPS
- [ ] Telegram commands working (`/status`, `/daily`, etc.)
- [ ] Receiving trade notifications on Telegram
- [ ] `.env` file has correct API credentials
- [ ] `TRADING_MODE=live` in `.env`
- [ ] Daily loss limit set appropriately
- [ ] Position sizes are comfortable
- [ ] GitHub repository is up to date
- [ ] VPS has adequate memory (512MB+)
- [ ] Auto-restart is enabled
- [ ] Tested `/restart` command in Telegram

## Support

If you encounter issues:

1. Check logs: `docker compose logs enclave-bot`
2. Verify environment variables in `.env`
3. Test Telegram bot with `/status`
4. Review GitHub issues: https://github.com/Turnipnator/enclave-bot/issues

## Remote Control from Telegram

Once deployed, you can control your bot entirely from Telegram:

- `/status` - Check if bot is running, view balance and positions
- `/restart` - Restart the bot remotely
- `/stop` - Stop the bot safely (closes positions first)
- `/daily` - Review today's performance
- `/weekly` - Check weekly stats
- `/alltime` - View total performance

This means you can manage your bot from anywhere without SSH access!

## Next Steps

1. ✅ Deploy to VPS with `./deploy.sh`
2. ✅ Verify with `/status` in Telegram
3. ✅ Monitor first trades
4. ✅ Adjust strategy parameters as needed
5. ✅ Set up daily performance reviews

Happy trading! 🚀💰
