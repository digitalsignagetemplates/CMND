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
1. Download de firmware (`update.zip`) per serie bij PPDS, bijvoorbeeld via het One_Link-overzicht.
2. Zet hem in `firmware\<serie>\update.zip` en de versie in `firmware\<serie>\version.txt` (zoals het scherm hem meldt, bv. `1.028`). `<serie>` is bijvoorbeeld `4650D` of `5050D`.
3. Vul `displayFtp` in `config.json` in (FTP-account van de schermen, poort 2121). Het wachtwoord in Control staat versleuteld opgeslagen en is niet bruikbaar.
4. **Voortest (start geen upgrade):** `node tools\test-firmware.js <ip>`. Het script controleert:
   - de firmwareversie via SICP, en welke notatie je in `version.txt` moet gebruiken;
   - de FTP-login;
   - het uploaden van een testbestand van 1 MB, dat daarna weer wordt verwijderd;
   - hoe lang de upload van `update.zip` ongeveer duurt.
5. In de tool: selecteer de schermen, open het tabblad Firmware en typ `UPGRADE`. Standaard gaat het één scherm tegelijk. De tool uploadt het bestand, start de upgrade en leest daarna de versie terug (wacht maximaal `firmwareWaitMinutes`).

Commando's die niet getest en niet gedocumenteerd zijn, worden geweigerd, tenzij `sicp.allowUnverified` op `true` staat.

## Op een andere pc of op het LAN zetten
1. Kopieer de hele map en installeer Node.js.
2. Zet in `config.json` `host` op `0.0.0.0` en vul `auth.user`/`auth.password` in.
3. Zet de Windows Firewall voor poort 8090 alleen open voor het beheersubnet.
4. Elke uitgevoerde actie wordt gelogd in `data\acties.jsonl`.

## Minimale Android-versie
`minAndroid` staat op `7.1.2`. Er bestaat geen Android 7.2: de laatste 7.x is 7.1.2. Schermen onder dit minimum worden getoond, maar krijgen geen acties.
