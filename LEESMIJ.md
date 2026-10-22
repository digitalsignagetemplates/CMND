# D-Line beheer (prototype)

Lokale aanvulling op CMND & Control voor PPDS D-Line-schermen (Android ≥ `minAndroid`). Functies:
- power-status per scherm, met uitleg wat elke status doet
- bulkacties: aan/uit, power-save-modus en SmartPower, opstartbron, powerschema
- per scherm en per actie de status: verstuurd, bevestigd, mislukt of geen reactie
- screenshots per scherm

## Starten
Vereist: Node.js 18 of nieuwer. Er zijn geen npm-packages nodig.

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

Commando's die niet getest en niet gedocumenteerd zijn, worden geweigerd, tenzij `sicp.allowUnverified` op `true` staat.

## Op een andere pc of op het LAN zetten
1. Kopieer de hele map en installeer Node.js.
2. Zet in `config.json` `host` op `0.0.0.0` en vul `auth.user`/`auth.password` in.
3. Zet de Windows Firewall voor poort 8090 alleen open voor het beheersubnet.
4. Elke uitgevoerde actie wordt gelogd in `data\acties.jsonl`.

## Minimale Android-versie
`minAndroid` staat op `7.1.2`. Er bestaat geen Android 7.2: de laatste 7.x is 7.1.2. Schermen onder dit minimum worden getoond, maar krijgen geen acties.
