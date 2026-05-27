#!/usr/bin/env bash
# Cole ESTE script no terminal SSH da VPS (root), uma vez, para o agente Cursor poder conectar.
mkdir -p ~/.ssh
chmod 700 ~/.ssh
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXWwjaiJRD7Z710Xf8ruYMIwDmGztCO60CZmitrNVWS luciano@DESKTOP-0JGJT66'
grep -qF "$KEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$KEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
echo "Chave do agente instalada. Pode avisar no Cursor: pronto"
