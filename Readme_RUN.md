Automatic na ang reload. Basta naka-on ang Docker (docker compose up -d), i-save mo lang ang file sa VS Code at kusa na itong mag-a-update. Hindi mo na kailangang mag-rebuild, mag-restart, o pindutin ang Reload.

1. Website o server

- views/ o public/ (HTML, CSS, JS ng browser): kusang magre-refresh ang browser pagka-save.
- controllers/, routes/, services/, server.js atbp.: kusang magre-restart ang server (nodemon), tapos kusang magre-refresh ang browser pagbalik ng server (mga 2-3 segundo).

Tingnan sa docker compose logs -f app ang "[nodemon] restarting" o "[livereload]" para makita na nakita ang binago mo.

2. Mobile app (mobile/src/, mobile/App.js)

Kusang mag-a-update ang app sa Expo Go (Fast Refresh) pagka-save. Makikita sa docker compose logs -f expo ang "[poll-watch] changed: ...".

Kung minsan hindi nag-update (hal. may error dati sa code), iling ang phone → Reload.

3. .env o docker-compose.yml

docker compose up -d

Kusa nitong ire-recreate ang mga container na naapektuhan.

4. Kung nag-install ka ng bagong package (binago ang package.json)

Server: docker compose up -d --build -V app
Mobile: docker compose build expo, tapos docker compose up -d expo

(Ang -V sa server ay para palitan ang lumang node_modules sa loob ng container ng bago.)

Mga madalas gamitin:

Gusto mong gawin	Command
Tingnan ang error ng server	docker compose logs -f app
Ipakita ulit ang Expo QR	docker compose logs expo --tail 60
Tingnan kung tumatakbo lahat	docker compose ps
Simulan lahat (hal. pagkatapos mag-restart ng PC)	docker compose up -d
