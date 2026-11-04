# D-Line beheer (prototype)

Lokale aanvulling op CMND & Control voor alle Philips/PPDS-signageschermen met SICP over LAN (D-, Q-, T-Line enz.). Welke functies werken, hangt af van model en SICP-versie: wat een scherm niet ondersteunt, toont de tool als "–", en acties daarop eindigen als "mislukt (NAV)".

T-Line (getest op 32BDL3751T, SICP 2.13): power, bron, power save, opstartbron, gedrag na stroomuitval en firmware zijn uit te lezen; schema en SmartPower ondersteunt dat model niet.

Q-Line (getest op 65BDL3550Q, SICP 2.09) leest power, bron, power save, opstartbron en schema uit. SmartPower, het gedrag na stroomuitval en de firmwareversie via SICP worden op dat model niet ondersteund. De tool toont dan de firmware uit Control. Functies:
- power-status per scherm, met uitleg wat elke status doet
- bulkacties: aan/uit, power-save-modus en SmartPower, opstartbron, powerschema
- per scherm en per actie de status: verstuurd, bevestigd, mislukt of geen reactie
- screenshots per scherm

## Starten
Vereist: Node.js 18 of nieuwer. Er zijn geen npm-packages nodig.

Dubbelklik `start.cmd`: de tool start en opent de browser. Laat het zwarte venster open zolang je de tool gebruikt.

**Poort al in gebruik?** Standaard draait de tool op poort 8090. Is die bezet, dan neemt hij vanzelf de volgende vrije poort (8091, 8092, …); het adres staat in het venster. Een vaste poort kies je met `"port"` in `config.json` of met `node server.js --port 8095`.

Krijg je de melding "The term 'node' is not recognized", dan staat Node.js niet op de pc. Installeer het met `winget install OpenJS.NodeJS.LTS` of via nodejs.org. Open daarna een **nieuw** PowerShell-venster, zodat het PATH wordt bijgewerkt.

```
node server.js
```
Of dubbelklik `start.cmd`. Open daarna http://127.0.0.1:8090.

## Modi (`config.json`)
- `"mode": "demo"`: 25 gesimuleerde schermen. Er gaat **niets** over het netwerk.
- `"mode": "sicp"`: de echte schermen uit `devices.json` (kopie van `devices.example.json`), via SICP op TCP-poort 5000.

## Wat werkt live en wat nog niet
Bron voor alle codes: *The SICP Commands Document V2.13* van PPDS.

| Functie | SICP | Status |
|---|---|---|
| Power aan/uit + uitlezen | 0x18 / 0x19 | getest op 50BDL4650D |
| Huidige bron, SmartPower, power save, opstartbron, na stroomuitval uitlezen | 0xAD, 0xDE, 0xD3, 0xBA, 0xA4 | getest op 4650D/5050D |
| Power save instellen | 0xD2 | getest op 50BDL4650D (gezet en hersteld) |
| SmartPower instellen | 0xDD | getest op 50BDL4650D (de 5050D ondersteunt SmartPower niet) |
| Bron nu wisselen | 0xAC | getest op 50BDL4650D (HDMI 1 en terug naar Custom) |
| Opstartbron instellen | 0xBB | getest op 50BDL4650D |
| Powerschema uitlezen/instellen | 0x5B / 0x5A (+ reset 0x60) | getest op 50BDL4650D; reset 0x60 gedocumenteerd, niet apart getest |
| Screenshot laten maken | 0x58 (+ 0x7E beschikbaarheid) | het scherm **mailt** de screenshot; e-mail moet op het scherm ingesteld zijn |
| Screenshot bekijken | – | nieuwste afbeelding uit `screenshotDir\<screenshotFolder, serienummer of IP>` |

| Firmwareversie uitlezen | 0xA1 0x01 | getest (bv. 1.027) |
| Firmware-upgrade | FTP-upload `update.zip` + 0x20 | gedocumenteerd (§11.13), **nog niet op een scherm getest** |

### Firmware-upgrade
Bron: de **PPDS-kennisbank** (https://www.ppds.com/support/kb/signage), op advies van PPDS. One_Link wordt niet meer gebruikt: dat overzicht bevatte fouten.

Een scherm heeft twee firmwaredelen:
- **Android-firmware (FBxx.yy):** wordt bijgewerkt met `update.zip`. Dit doet de tool. Uitlezen gaat met SICP `0xA1 0x03`.
- **Scaler-firmware (v1.0xx):** wordt alleen getoond. Bijwerken gaat volgens de instructies van PPDS.

1. In `kb-catalog.json` staat per serie de PPDS-pagina, met het pagina-ID. Een nieuwe serie voeg je daar toe. Het ID vind je in het netwerkverkeer van de pagina (`SharedContentQuery` → `singleContent.id`).
2. Open in de tool het tabblad **Firmware**. De tool raadpleegt de kennisbank en toont per serie de nieuwste Android- en scaler-versie, het platform en links naar de pagina, de release notes en de instructies. Gebruik **Vernieuwen** om de kennisbank opnieuw te raadplegen.
3. Klik bij de serie op **Ophalen**. De knop verschijnt alleen als de kennisbank een los `update.zip` geeft. Bij een combinatiepakket (`combofw.zip`) of een PDF met instructies is het handmatig werk. De tool downloadt het bestand naar `firmware\<serie>\` en toont voor welk apparaat het volgens de update zelf bedoeld is.
   - Noemt het bestand een interne codenaam in plaats van het model, dan blokkeert de tool de upgrade tot je die codenaam bij `otaAliases` in `config.json` toestaat. Doe dat alleen na bevestiging door PPDS.
   - Verwijst PPDS naar een PDF (zoals bij de 3550Q), dan haalt de tool de link naar `update.zip` uit die PDF.
   - Een combinatiepakket (`combofw.zip`, scaler en Android samen) installeert de tool niet. PPDS beschrijft dat alleen via USB.
4. **Controles vlak voor de upgrade:**
   - het scherm staat op power save **Mode 4**. Dat schrijft PPDS voor in de FW Update SOP;
   - serienummer en model van het scherm moeten overeenkomen met Control;
   - het platform van het scherm (SICP `0xA2 0x01`) moet overeenkomen met het platform op de PPDS-pagina;
   - de Android-versie moet uitleesbaar zijn, zodat de tool na afloop kan controleren of de upgrade gelukt is.
5. Vul `displayFtp` in `config.json` in (FTP-account van de schermen, poort 2121). Het wachtwoord in Control staat versleuteld opgeslagen en is niet bruikbaar.
6. **Voortest (start geen upgrade):** `node tools\test-firmware.js <ip>`. Het script controleert:
   - de Android-firmware en het platform via SICP;
   - de FTP-login;
   - het uploaden van een testbestand van 1 MB, dat daarna weer wordt verwijderd;
   - hoe lang de upload van `update.zip` ongeveer duurt.
7. **Bulk bijwerken in het overzicht "Firmware-updates"** (onder de schermlijst):
   1. Kies een **serie**. Elke tegel toont het aantal schermen, hoeveel een update nodig hebben, en of de firmware klaarstaat.
   2. Vink de schermen aan (of **Alles**) en klik op **Controleer geselecteerde**. Per scherm zie je ✓/✗ voor: bereikbaar, aan, juist apparaat, versie uitleesbaar, Mode 4, platform, bestand en FTP-login. Bij een ✗ staan de reden en de oplossing erbij. De controle wijzigt niets, behalve dat hij één keer inlogt op de FTP-server.
   3. Gebruik zo nodig **Zet Mode 4 op geselecteerde** en controleer opnieuw.
   4. **Selecteer alle klare** en klik op **Start update**. Je krijgt een samenvatting met het aantal schermen, de versies van → naar en een geschatte duur. Je kiest hoeveel schermen tegelijk (1–3; standaard 1) en bevestigt met `UPGRADE`.
   5. In hetzelfde overzicht volg je de voortgang: het totaal (klaar / bezig / mislukt / wachtrij) en per scherm de fase. De tool uploadt het bestand, start de upgrade en leest daarna de versie terug (wacht maximaal `firmwareWaitMinutes`).

Commando's die niet getest en niet gedocumenteerd zijn, worden geweigerd, tenzij `sicp.allowUnverified` op `true` staat.

### signageOS (optioneel)
Draait er signageOS op de schermen, dan kan de tool firmware en screenshots via signageOS doen. Er is dan geen FTP-server op het scherm en geen update.zip nodig.
1. Maak in signageOS Box onder **Organizations → (organisatie) → API tokens** een token aan.
2. Zet het in `config.local.json` (dit bestand gaat niet mee naar GitHub):
   ```json
   "signageos": { "tokenId": "...", "tokenSecret": "..." }
   ```
3. Herstart de tool. Schermen worden aan signageOS gekoppeld op **serienummer** (ververst elke 5 minuten).

Wat er dan verandert:
- **Firmware:** in het firmware-overzicht staat per serie hoeveel schermen gekoppeld zijn. Met **Firmware zoeken in signageOS** kies je de firmware uit de signageOS-catalogus die bij de nieuwste PPDS-versie hoort. Past er precies één bij het model, dan kiest de tool die zelf. Gekoppelde schermen worden daarna via signageOS bijgewerkt ("via signageOS" in de tabel). De rest gaat via FTP + SICP. De voorcontrole (bereikbaar, juist apparaat, Mode 4, platform) blijft via SICP.
- **Screenshots:** gekoppelde schermen leveren een live screenshot via signageOS. Lukt dat niet, dan toont de tool de laatste screenshot uit Control.
- Zonder token werkt alles zoals voorheen. Fouten van signageOS hebben eigen codes (`SOS_*`), bijvoorbeeld een ongeldig token of een functie die niet in het abonnement zit.

## Foutmeldingen
Elke mislukte of overgeslagen actie krijgt een vaste foutcode, met uitleg in gewone taal: wat er misging, waarom, en wat je eraan doet. De teksten staan in `drivers/errors.js`.
- **Per actie** staan de problemen gegroepeerd, bijvoorbeeld "12× Geheugen van het scherm vol", met de oplossing en de schermen erbij.
- **Per scherm:** klik op een scherm in een actie voor de details: foutcode, uitleg, technische melding, tijden en (bij firmware) de fase waarin het misging (voorcontrole → upload → upgrade starten → herstart + controle → klaar).
- **CSV:** met de knop *CSV* bij een actie download je het resultaat per scherm voor Excel (status, fase, foutcode, probleem, wat te doen, technische melding, tijden).

## Op een andere pc of op het LAN zetten
1. Kopieer de hele map en installeer Node.js.
2. Zet in `config.json` `host` op `0.0.0.0` en vul `auth.user`/`auth.password` in.
3. Zet de Windows Firewall voor poort 8090 alleen open voor het beheersubnet.
4. Elke uitgevoerde actie wordt gelogd in `data\acties.jsonl`.

## Minimale Android-versie
`minAndroid` staat op `7.1.2`. Er bestaat geen Android 7.2: de laatste 7.x is 7.1.2. Schermen onder dit minimum worden getoond, maar krijgen geen acties.
