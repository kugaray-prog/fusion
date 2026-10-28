Depende kung anong code ang binago mo. Patakbuhin ang mga command na ito sa terminal ng VS Code, sa C:\fusion.

1. Website o server (views/, public/, controllers/, routes/, services/, server.js atbp.)

docker compose up -d --build app

Hintayin ng mga 30 segundo, tapos i-refresh ang browser gamit ang Ctrl+F5. Kailangan ang --build kasi nakakopya sa loob ng Docker image ang code ng server, kaya hindi nito makikita ang binago mo kung walang rebuild.

2. Mobile app (mobile/src/, mobile/App.js)

docker compose restart expo

Sa phone, i-reload ang app sa Expo Go: iling ang phone → Reload. Kailangan ang restart kasi hindi napapansin ng Expo sa Docker ang mga binago mo galing Windows.

3. .env o docker-compose.yml

docker compose up -d

Kusa nitong ire-recreate ang mga container na naapektuhan.

4. Kung nag-install ka ng bagong package (binago ang package.json)

Server: docker compose up -d --build app
Mobile: docker compose build expo, tapos docker compose up -d expo
Mga madalas gamitin:

Gusto mong gawin	Command
Tingnan ang error ng server	docker compose logs -f app
Ipakita ulit ang Expo QR	docker compose logs expo --tail 60
Tingnan kung tumatakbo lahat	docker compose ps
Simulan lahat (hal. pagkatapos mag-restart ng PC)	docker compose up -d
Kung ayaw mong mag-rebuild tuwing may babaguhin sa website, puwede kong i-setup ang app container para kusa itong mag-reload kapag nag-save ka. Sabihin mo lang kung gusto mo.



