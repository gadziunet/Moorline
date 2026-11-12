<p align="center"><img src="assets/banner.png" alt="Stackmoor – stacki Docker Compose bez myślenia o ścieżkach wolumenów" width="100%"></p>

# Stackmoor

Webowy panel do stacków Docker Compose na własnym serwerze – w duchu Dockge, ale bez myślenia o ścieżkach wolumenów. Każdy stack trzyma dane we własnym folderze, kopie zapasowe obejmują zrzuty baz danych, a każda aplikacja może dostać domenę lokalną z prawdziwym certyfikatem HTTPS.

**[Strona](https://stackmoor.dev)** · **[Dokumentacja](https://docs.stackmoor.dev/pl/)** · **[Wydania](https://github.com/gadziunet/stackmoor/releases)** · [English](README.md)

> **Status:** v0.6 – stacki, automatyczne wolumeny, domeny lokalne, kopie zapasowe i przywracanie całego serwera z kopii działają i są używane na prawdziwych serwerach. To wciąż młode oprogramowanie – miej też własne kopie.

## Instalacja

Na czystym Debianie, Ubuntu albo Raspberry Pi OS (x86_64 lub arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/gadziunet/stackmoor/main/install.sh | sudo bash
```

Skrypt instaluje Dockera, jeśli go brakuje, uruchamia Stackmoor i wypisuje adres oraz jednorazowy kod instalacyjny, np. `http://192.168.1.50:5001` i `K7QM-4XWD-9TPA`. Przy pierwszym wejściu wpisujesz kod i tworzysz konto administratora – dzięki temu nikt inny w Twojej sieci nie zrobi tego przed Tobą. Zgubiony kod: `docker logs stackmoor | grep "Setup code"`.

Ponowne uruchomienie tego samego polecenia aktualizuje panel. Opcjonalnie: `curl ... | sudo PORT=8080 STACKS_DIR=/srv/stacks bash`.

> Stackmoor ma dostęp do gniazda Dockera, czyli pełną kontrolę nad maszyną. Trzymaj go w sieci lokalnej albo za VPN.

## Co potrafi

- lista stacków ze statusem na żywo
- tworzenie stacka przez wklejenie `compose.yaml` (+ opcjonalny `.env`)
- edytor z walidacją przez `docker compose config` – błędny plik nie zostanie zapisany
- Uruchom, Restart, Aktualizuj (pull + up), Zatrzymaj, Wyłącz – z wyjściem na żywo
- logi na żywo, kontenery z portami, historia operacji
- usuwanie stacka przenosi folder do `.trash/` – nic nie znika przypadkiem
- automatyczne aktualizacje stacków w wybrane dni (domyślnie wyłączone): najpierw kopia, powrót do poprzednich obrazów, gdy nowe się nie uruchomią
- restart serwera z panelu albo według harmonogramu; stacki, które działały, uruchamiają się ponownie – także te bez `restart:`
- powiadomienia e-mailem, przez Telegram, ntfy, Pushover albo webhook – np. gdy nie uda się kopia, stack przestanie działać albo padnie VPN
- publiczne adresy przez Twojego Pangolina – panel sam tworzy site, uruchamia Newt i dodaje zasoby
- strona „uruchamia się” zamiast kręcącego się kółka, gdy panel, aplikacja albo serwer za proxy startuje po restarcie lub aktualizacji
- zabezpieczony od początku: jednorazowy kod instalacyjny, limit logowania nie do obejścia podrobionymi nagłówkami, nagłówki bezpieczeństwa (CSP, zakaz osadzania), sprawdzane przywracanie
- interfejs po polsku i angielsku

## Automatyczne wolumeny

Nie wpisujesz ścieżek na hoście. Każdy stack ma folder `/opt/stacks/<nazwa>/`, a dane aplikacji lądują w `/opt/stacks/<nazwa>/data/`:

| W compose | Po zapisie |
|---|---|
| `- /config` | `- ./data/app-config:/config` |
| `- /jakas/sciezka:/config` | `- ./data/app-config:/config` |
| `- db_data:/var/lib/mysql` | `- ./data/db_data:/var/lib/mysql` |
| nic, ale obraz ma `VOLUME /data` | przy uruchomieniu dopisywane `- ./data/app-data:/data` |

Bez zmian zostają: ścieżki systemowe (`docker.sock`, `/dev`, `/etc/localtime`…), ścieżki z listy dozwolonych w Ustawieniach (domyślnie `/mnt`, `/media` – np. dyski z filmami, bez backupu), ścieżki z `${ZMIENNYMI}`, ścieżki względne wewnątrz stacka i wolumeny `external`.

Panel pokazuje po zapisie, co zmienił. Foldery tworzy przed startem z właścicielem `PUID:PGID` (domyślnie 1000:1000), żeby nie powstały jako root. Jeśli aplikacja montuje pojedynczy **plik** (np. `nginx.conf`), panel nie pozwoli wystartować bez niego, bo Docker utworzyłby w tym miejscu pusty folder.

Automatyczne wolumeny można wyłączyć dla wybranego stacka.

## Przeniesienie aplikacji z innego panelu (np. Dockhand)

1. Utwórz `/opt/stacks/<nazwa>/data/` i skopiuj tam dane aplikacji (dokładną nazwę podfolderu panel pokaże po zapisie compose).
2. Zatrzymaj aplikację w starym panelu.
3. W Stackmoor utwórz stack z tym samym compose – ścieżki zostaną przepięte na `./data/...`.
4. Uruchom i sprawdź.

Stack można utworzyć w istniejącym folderze bez `compose.yaml`, więc dane możesz wgrać wcześniej.

## Domeny lokalne

Każdy stack może dostać adres typu `chmura.dom.example.com` z prawdziwym certyfikatem HTTPS – bez pamiętania portów i bez wystawiania serwera do internetu.

1. **Zaraz po instalacji** (albo później w zakładce **Domeny**): wpisz domenę, wybierz dostawcę DNS (Cloudflare, Bunny, OVHcloud, Hetzner, DigitalOcean, Porkbun, Namecheap, GoDaddy, IONOS, netcup, Gandi, AWS Route 53, deSEC, DuckDNS) i wklej klucz API. Klucze są zapisywane w formie zaszyfrowanej.
2. Rekordy DNS `dom.example.com` i `*.dom.example.com` → lokalny adres IP serwera **dodają się same** dla Cloudflare, Bunny, Hetzner, DigitalOcean, Porkbun, deSEC i DuckDNS (u pozostałych dostawców dodaj je ręcznie). Adres IP serwera jest wykrywany automatycznie, a rekordy aktualizują się, gdy się zmieni. Przed zapisaniem Stackmoor sprawdza klucz API i ostrzega, jeśli domena wskazuje już na inny serwer.
3. **Stack → Domena:** wybierz subdomenę, usługę i jej port w kontenerze.
4. **Inne serwery (+ Proxy):** daj adres także urządzeniu albo serwerowi spoza Stackmoor – Proxmoxowi, routerowi, NAS-owi: wpisz jego IP i port (http albo https, z opcją akceptowania jego własnego certyfikatu). Pulpit pokazuje, czy odpowiada.

Stackmoor uruchamia Caddy we własnym kontenerze (`stackmoor-caddy`) z jednym certyfikatem wildcard dla wszystkich aplikacji. Caddy aktualizuje się razem z panelem – każde wydanie ma własny obraz Caddy. Dostawcę DNS można zmienić w każdej chwili w Ustawieniach. Na Unraid porty 80/443 zajmuje jego panel – wybierz inne w sekcji *Zaawansowane*.

**Adres samego panelu.** Wpisz *Adres tego panelu* (np. `stackmoor`), a panel będzie dostępny także pod `https://stackmoor.dom.example.com`. Gdy otworzysz go pod tym adresem, możesz włączyć *Panel tylko pod tym adresem* – wejście przez adres IP zostanie wtedy zablokowane, a panel otworzy się tylko pod swoją domeną. Gdyby domena kiedyś przestała działać, odblokujesz panel poleceniem:

```bash
docker exec stackmoor node src/cli.js unlock
```

## Kopie zapasowe

Zakładka **Kopie** → **Ustawienia kopii:** wybierz magazyn (Backblaze B2, Amazon S3, Cloudflare R2, Hetzner, Wasabi albo dowolny zgodny z S3), wklej klucze, ustaw hasło szyfrowania, dni i godzinę oraz ile kopii trzymać.

- **Jedno zaszyfrowane repozytorium** ([restic](https://restic.net)) w Twoim buckecie mieści wszystkie stacki i ustawienia samego panelu. Niezmienione pliki nie są wysyłane ponownie.
- **Najpierw zrzuty baz danych** (PostgreSQL, MySQL/MariaDB, MongoDB; Redis jest zapisywany), a aplikacje działają dalej. Do kopii trafia zrzut zamiast surowych plików bazy. Usługa może sama wskazać typ etykietą `stackmoor.backup.dump: postgres|mysql|mongo|redis|none`.
- **Przed każdą aktualizacją** robiona jest kopia stacka; jeśli się nie uda, aktualizacja się nie wykona.
- **Sumy kontrolne:** restic zapisuje każdy kawałek danych pod jego sumą SHA-256. Każde uruchomienie sprawdza repozytorium, raz w tygodniu 10% danych jest pobierane i porównywane, a *Zweryfikuj wszystko* sprawdza całość.
- **Rotacja:** ile kopii dziennych, tygodniowych i miesięcznych trzymać; starsze są usuwane automatycznie.
- **Przywracanie** z zakładki *Kopie* w stacku: obecny folder trafia do kosza, pliki wracają, bazy są wczytywane ze zrzutów, a stack się uruchamia. Przywrócenie pod inną nazwą tworzy kopię. Kopie są pogrupowane po uruchomieniu, a *Przywróć wszystkie stacki* odtwarza wszystkie stacki z danego uruchomienia.
- **Nowy serwer:** na świeżej instalacji wybierz *Przywróć serwer z kopii zapasowej*, podaj bucket i hasło szyfrowania, wybierz kopię – wracają ustawienia panelu, Twoje konto, domeny i wszystkie stacki razem z bazami.

> Przechowuj hasło szyfrowania w bezpiecznym miejscu. Bez niego nikt nie przywróci kopii.

## Łącz przez VPN

Wybrane aplikacje wysyłają ruch Twoim tunelem **WireGuard** – jak drugie łącze tylko dla nich. Typowy przypadek: webowy klient SSH (np. Termix) na domowym serwerze łączy się z VPS-ami, których firewall wpuszcza tylko stały adres tunelu.

1. **Sieć → VPN:** dodaj tunel – wklej swój plik `.conf`.
2. **Stack → VPN:** wybierz tunel i usługi, które mają z niego korzystać.

To, co idzie tunelem, wynika z `AllowedIPs` w Twoim pliku. **Blokada (kill switch) jest zawsze włączona:** gdy tunel nie działa, te aplikacje nie mają w ogóle internetu, a panel pokazuje ostrzeżenie. Szczegóły: [docs.stackmoor.dev/pl/guides/vpn](https://docs.stackmoor.dev/pl/guides/vpn/).

## Plan

- [x] Stacki, edytor, automatyczne wolumeny, logi
- [x] Domeny lokalne przez Caddy – certyfikat wildcard przez API dostawcy DNS (14 dostawców) albo wewnętrzny CA
- [x] Backupy jak w Cloudronie – per stack, automatycznie przed aktualizacją, dumpy baz, harmonogram, retencja, szyfrowanie; restic do S3 / Backblaze B2; przywracanie i klonowanie
- [x] Kreator: nowa instalacja albo przywrócenie całego serwera z kopii
- [x] Aktualizacje: sprawdzanie nowych wersji Stackmoor i nowych obrazów stacków (włączane w Ustawieniach), pokazanie co nowego; sam panel aktualizuje się dopiero po potwierdzeniu
- [x] Kreator: start po adresie IP albo od razu z domeną; rekord DNS dodaje się przez API dostawcy, a domena jest najpierw sprawdzana
- [x] Łącz przez VPN (WireGuard) dla wybranych usług – np. łączenie z serwerami ze stałego adresu; blokada (kill switch) zawsze włączona
- [x] Nowy wygląd: górne menu, pulpit, pasek stanu, jasny i ciemny motyw
- [x] Proxy: adresy w Twojej domenie dla innych serwerów (Proxmox, routery, NAS) ze sprawdzaniem stanu
- [x] Automatyczne aktualizacje stacków (domyślnie wyłączone) z kopią przed aktualizacją i powrotem do poprzedniej wersji, gdy nowa się nie uruchomi; restart serwera z panelu i według harmonogramu; automatyczne łatki systemu (Debian/Ubuntu)
- [x] Powiadomienia (e-mail, Telegram, ntfy, Pushover, webhooki): nieudane kopie, stack, który przestał działać, VPN albo proxy nie działa, automatyczne aktualizacje, restarty
- [x] Pangolin – publiczne adresy obok lokalnej domeny, z logowaniem Pangolina przed aplikacją; foldery pomijane w kopiach
- [x] Wzmocnienie bezpieczeństwa (0.13): kod instalacyjny przy nowej instalacji, przekazywane nagłówki tylko od Caddy, asynchroniczne hashowanie haseł, nagłówki bezpieczeństwa, sprawdzane przywracanie; strona ładowania z Caddy
- [x] Osobna, wewnętrzna sieć Dockera dla Caddy i panelu – aplikacje nie mają bezpośredniego dostępu do panelu (0.13.1)
- [ ] Dalsze wzmocnienia: ściślejsze sprawdzanie konfiguracji VPN, bezpieczniejszy zapis plików w folderach stacków
- [ ] Więcej języków interfejsu
- [ ] Szablon Unraid w Community Apps

## Rozwój

```bash
npm install
STACKS_DIR=$HOME/stacks npm run dev   # http://localhost:5001
npm test
```

Wymaga Node 20+ oraz `docker` z wtyczką `compose`. Albo przez Dockera: `docker compose up -d --build` (ustaw `STACKS_DIR` w `.env`). Opis zmiennych i struktury plików – w [README po angielsku](README.md#development).

Tłumaczenia: dopisz blok języka w `src/i18n.js` i `public/i18n.js` – testy sprawdzają, czy każdy język ma wszystkie klucze.

## Jak powstaje

Stackmoor jest pisany z pomocą AI – [Claude](https://claude.ai) od Anthropic. Ja projektuję funkcje, przeglądam zmiany i każde wydanie sam testuję na prawdziwych serwerach (Debian i Unraid), zanim je opublikuję. Kod jest objęty testami automatycznymi uruchamianymi przy każdym pushu.

Jeśli znajdziesz błąd, [zgłoś go tutaj](https://github.com/gadziunet/stackmoor/issues).

## Licencja

[AGPL-3.0](LICENSE) © Gadziunet. Możesz używać, zmieniać i udostępniać Stackmoor za darmo; jeśli rozpowszechniasz zmienioną wersję albo udostępniasz ją jako usługę w sieci, musisz opublikować swoje zmiany na tej samej licencji.
