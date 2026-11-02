// Foutcatalogus: elke fout heeft een vaste code, een titel, de oorzaak en wat je eraan doet.
// De UI toont deze teksten; de technische melding blijft als detail beschikbaar.

const CATALOG = {
  // Bereikbaarheid en identiteit
  NO_REPLY: { title: 'Geen reactie van het scherm', cause: 'Het scherm antwoordde niet op tijd via SICP (TCP-poort 5000).', fix: 'Controleer of het scherm aan staat, op het netwerk is aangesloten en of netwerkbediening (SICP) aan staat. Bij power-save Mode 1/2 is het netwerk in standby uit.' },
  UNREACHABLE: { title: 'Scherm niet bereikbaar', cause: 'Er kon geen verbinding worden gemaakt met het IP-adres van het scherm.', fix: 'Controleer het IP-adres in Control, de netwerkkabel/wifi en of het scherm aan staat. Gebruik bij voorkeur vaste IP-adressen (DHCP-reservering).' },
  IDENTITY_MISMATCH: { title: 'Ander apparaat op dit IP-adres', cause: 'Het serienummer of model dat het scherm meldt, komt niet overeen met Control. Waarschijnlijk is het IP-adres via DHCP aan een ander apparaat gegeven.', fix: 'Werk het IP-adres van het scherm bij in CMND & Control, of geef de schermen een vast IP-adres.' },
  NOT_IN_CONTROL: { title: 'Scherm staat niet meer in Control', cause: 'Het scherm is uit CMND & Control verwijderd tijdens de actie.', fix: 'Controleer de schermlijst in Control.' },

  // SICP-antwoorden
  NAV: { title: 'Niet ondersteund door dit model', cause: 'Het scherm antwoordde "NAV": deze functie of waarde bestaat niet op dit model of deze firmware.', fix: 'Geen actie nodig voor dit scherm, of kies een waarde die het model wel ondersteunt.' },
  NACK: { title: 'Commando geweigerd', cause: 'Het scherm antwoordde "NACK": het commando is ontvangen maar geweigerd.', fix: 'Controleer of de gekozen waarde geldig is voor dit model en probeer het opnieuw.' },
  VERIFY_FAILED: { title: 'Niet bevestigd na uitvoeren', cause: 'Het scherm accepteerde het commando, maar bij het teruglezen staat er een andere waarde.', fix: 'Probeer het opnieuw. Blijft het afwijken, controleer dan in het menu van het scherm of een andere instelling dit overschrijft (bijv. Control of een schema).' },
  NOT_TESTED: { title: 'Niet verstuurd: commando niet getest', cause: 'Dit commando is voor dit profiel nog niet getest of gedocumenteerd; de tool stuurt het daarom niet.', fix: 'Test het commando eerst op één scherm en zet het in profiles.json op verified.' },

  // Firmware: voorcontroles
  FW_NO_FILE: { title: 'Geen firmware klaargezet', cause: 'Voor de serie van dit scherm staat geen update.zip in de firmwaremap.', fix: 'Klik in het tabblad Firmware bij de serie op Ophalen.' },
  FW_VERSION_UNREADABLE: { title: 'Firmwareversie niet uitleesbaar', cause: 'Het scherm meldt zijn Android-versie niet via SICP (0xA1 0x03). Na een upgrade kan de tool dan niet controleren of die gelukt is.', fix: 'Werk dit scherm handmatig bij via USB volgens de instructies van PPDS.' },
  FW_ALREADY_CURRENT: { title: 'Al actueel', cause: 'Het scherm draait de klaargezette versie al.', fix: 'Geen actie nodig.' },
  FW_NOT_MODE4: { title: 'Power save staat niet op Mode 4', cause: 'PPDS schrijft voor dat het scherm tijdens een firmware-update op power save Mode 4 staat.', fix: 'Zet het scherm op Mode 4 (tabblad Power save) en start de upgrade opnieuw.' },
  FW_PLATFORM_MISMATCH: { title: 'Firmware past niet bij dit platform', cause: 'Het platform dat het scherm meldt, verschilt van het platform op de PPDS-pagina.', fix: 'Controleer of het scherm in de juiste serie staat en of de juiste firmware is opgehaald. Niet forceren.' },
  FW_OTA_MISMATCH: { title: 'Firmwarebestand is voor een ander apparaat', cause: 'Volgens het update.zip zelf is het bestand voor een ander apparaat bedoeld.', fix: 'Haal de firmware opnieuw op via de PPDS-kennisbank of vraag PPDS om de juiste firmware.' },
  FW_SCREEN_OFF: { title: 'Scherm staat uit', cause: 'Voor een firmware-upgrade moet het scherm aan staan.', fix: 'Zet het scherm aan (tabblad Aan/uit) en start de upgrade opnieuw.' },
  FW_NO_FTP_ACCOUNT: { title: 'Geen FTP-account ingesteld', cause: 'De tool heeft het FTP-account van de schermen nodig om update.zip te uploaden. Het wachtwoord in Control is versleuteld en niet bruikbaar.', fix: 'Vul displayFtp (gebruiker/wachtwoord, poort 2121) in config.local.json in.' },
  FW_BUSY: { title: 'Er loopt al een upgrade', cause: 'Op dit scherm loopt al een firmware-upgrade.', fix: 'Wacht tot die klaar is.' },

  // Firmware: upload
  FTP_UNREACHABLE: { title: 'FTP-server van het scherm niet bereikbaar', cause: 'Er kon geen verbinding worden gemaakt met de FTP-server op het scherm (poort 2121).', fix: 'Zet op het scherm de FTP-server aan (Instellingen → Signage Display → Server settings → FTP → Enable) en controleer de poort.' },
  FTP_LOGIN: { title: 'FTP-login geweigerd', cause: 'Gebruikersnaam of wachtwoord van de FTP-server op het scherm klopt niet.', fix: 'Zet op het scherm én in CMND hetzelfde FTP-wachtwoord als in config.local.json.' },
  FTP_STORAGE_FULL: { title: 'Geheugen van het scherm vol', cause: 'De upload stopte omdat er te weinig vrije ruimte op het scherm is.', fix: 'Maak ruimte vrij op het scherm (bijv. oude logbestanden in /philips/Log) of werk het scherm bij via USB volgens de PPDS-instructie.' },
  FTP_TRANSFER: { title: 'Upload afgebroken', cause: 'De verbinding viel weg tijdens het uploaden van de firmware.', fix: 'Controleer de netwerkverbinding (bij voorkeur bekabeld) en probeer opnieuw.' },
  FTP_SIZE_MISMATCH: { title: 'Bestand op het scherm onvolledig', cause: 'Na de upload is het bestand op het scherm niet even groot als het origineel.', fix: 'Probeer de upgrade opnieuw; blijft het misgaan, controleer de vrije ruimte op het scherm.' },

  // Firmware: uitvoeren en controle
  FW_NOT_STARTED: { title: 'Upgrade niet gestart', cause: 'Het scherm accepteerde het startcommando (SICP 0x20) niet.', fix: 'Controleer of het model de upgrade via SICP ondersteunt (vanaf SICP 2.06) en probeer opnieuw.' },
  FW_TIMEOUT: { title: 'Scherm na upgrade niet terug', cause: 'Na het starten van de upgrade reageerde het scherm niet meer binnen de wachttijd.', fix: 'Controleer het scherm ter plekke. Een upgrade kan langer duren; lees daarna de status opnieuw uit.' },
  FW_WRONG_VERSION: { title: 'Na upgrade een andere versie', cause: 'Het scherm is herstart, maar meldt niet de verwachte firmwareversie.', fix: 'Lees de versie opnieuw uit. Klopt het niet, controleer dan het firmwarebestand en de release notes van PPDS.' },

  UNKNOWN: { title: 'Onbekende fout', cause: 'Er ging iets mis dat de tool niet kon herkennen.', fix: 'Bekijk de technische melding hieronder.' },
};

// Herken een code uit een (technische) foutmelding, voor fouten zonder expliciete code.
function classify(msg) {
  const m = String(msg || '');
  if (/451|device might be full|no space|ENOSPC/i.test(m)) return 'FTP_STORAGE_FULL';
  if (/530|login/i.test(m) && /FTP/i.test(m)) return 'FTP_LOGIN';
  // Stilvallen ná het verbinden is een afgebroken overdracht, geen onbereikbare server.
  if (/Upload afgebroken|dataverbinding|tijdens sessie|ECONNRESET|EPIPE/i.test(m)) return 'FTP_TRANSFER';
  if (/FTP-server niet bereikbaar/i.test(m) || (/:2121\b/.test(m) && /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT/i.test(m))) return 'FTP_UNREACHABLE';
  if (/Grootte op scherm/i.test(m)) return 'FTP_SIZE_MISMATCH';
  if (/NAV/.test(m)) return 'NAV';
  if (/NACK/.test(m)) return 'NACK';
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(m)) return 'UNREACHABLE';
  if (/time-?out|geen antwoord|ETIMEDOUT/i.test(m)) return 'NO_REPLY';
  return 'UNKNOWN';
}

module.exports = { CATALOG, classify };
