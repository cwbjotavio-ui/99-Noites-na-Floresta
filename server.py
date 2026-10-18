#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Servidor de sala (lobby + relay) para "Chamas da Sobrevivência".

Ele NÃO simula o jogo: apenas repassa as mensagens entre os dispositivos.
O navegador do ANFITRIÃO (host) roda a simulação e envia snapshots;
os demais (clientes) enviam entradas. Funciona com PC e celular na mesma
rede Wi-Fi.

Uso:
    pip install websockets
    python3 server.py            # escuta em 0.0.0.0:8765

O mesmo processo pode servir o index.html via HTTP para facilitar o link:
    python3 http.server 8000     (em outro terminal)
"""
import asyncio
import json
import socket

try:
    import websockets
except ImportError:
    raise SystemExit("Instale a dependência:  pip install websockets")

HOST = "0.0.0.0"
PORT = 8765

clients = {}          # ws -> player dict {id, name, role, isTouch}
counter = [0]


def lobby_list():
    return list(clients.values())


async def broadcast(payload, exclude=None):
    data = json.dumps(payload, ensure_ascii=False)
    dead = []
    for ws in list(clients.keys()):
        if ws is exclude:
            continue
        try:
            await ws.send(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        drop(ws)


def drop(ws):
    p = clients.pop(ws, None)
    return p


async def handler(ws):
    me = None
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            t = msg.get("t")

            if t == "hello":
                counter[0] += 1
                pid = "p%d" % counter[0]
                me = {
                    "id": pid,
                    "name": str(msg.get("name", "Jogador"))[:12],
                    "role": "host" if msg.get("role") == "host" else "client",
                    "isTouch": bool(msg.get("isTouch")),
                    "idx": len(clients),
                }
                clients[ws] = me
                # avisa o novo jogador quem ele é
                await ws.send(json.dumps({"t": "welcome", "id": pid}, ensure_ascii=False))
                await broadcast({"t": "lobby", "players": lobby_list()})

            elif t == "input":
                # relay: anexa o id do remetente
                msg["id"] = me["id"] if me else None
                await broadcast(msg, exclude=ws)

            elif t == "snap":
                await broadcast(msg, exclude=ws)

            elif t == "start":
                # host iniciou o jogo -> repassa para todos os clientes
                await broadcast(msg, exclude=ws)

            elif t == "ping":
                await ws.send('{"t":"pong"}')

    finally:
        p = drop(ws)
        if p:
            await broadcast({"t": "peerdown", "id": p["id"]})
            await broadcast({"t": "lobby", "players": lobby_list()})


def get_lan_ip(sock):
    """Descobre o IP da LAN sem enviar tráfego real (truque do socket UDP)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return None
    finally:
        s.close()


async def main():
    srv = await websockets.serve(handler, HOST, PORT, max_size=2**20)
    # porta real (útil se PORT for 0) e IP da LAN para montar o link dos celulares
    port = srv.sockets[0].getsockname()[1]
    lan_ip = get_lan_ip(srv)
    print("🔥 Servidor do lobby rodando!")
    print("   Local (seu PC)     : ws://localhost:%d" % port)
    if lan_ip and not lan_ip.startswith("127."):
        print("   Rede (celulares)   : ws://%s:%d" % (lan_ip, port))
        print("   Link p/ compartilhar: http://%s:8000/index.html?join=1" % lan_ip)
    else:
        print("   (não foi possível detectar o IP da LAN; descubra com: hostname -I ou ipconfig)")
    print("   Abra o jogo no navegador do anfitrião e clique em 'Criar Sala'.")
    await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nEncerrado.")
