#!/usr/bin/env bash
# -*- coding: utf-8 -*-

get_server_ip() {
    IP=$(curl -s --max-time 10 https://api.ipify.org || echo "YOUR_SERVER_IP")
    echo "$IP"
}

main() {
    echo "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~"
    echo "开始安装依赖模块"
    echo "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~"
    npm install ws

    SERVER_IP=$(get_server_ip)
    echo "$SERVER_IP"
    echo "🚀 启动应用..."

    node index.js
}

main
