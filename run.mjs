# 2) تنزيل الكود في المسار القياسي /var/www
mkdir -p /var/www
cd /var/www
git clone https://github.com/quickitquote/qiq-mcp-server.git
cd qiq-mcp-server
git checkout main
git pull --rebase