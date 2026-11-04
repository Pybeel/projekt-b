# Klädd — hvad skal du have på i dag?

En vejrapp med tøjråd. **Back-end:** Node.js-server på localhost (ingen eksterne pakker).
**Front-end:** HTML, CSS og JavaScript (ES-moduler, ingen frameworks).

## Kom i gang

```bash
npm start          # eller: npm run dev  (genstarter selv, når server.js ændres)
```

Åbn <http://localhost:3000>. Stop serveren med `Ctrl + C`. Der skal ikke køres `npm install`.

## Opbygning

```
├── server.js            Node-server: statiske filer + REST-API + brugerdata
├── package.json
├── .gitignore           data/ kommer aldrig på GitHub
├── data/                oprettes automatisk: users.json, sessions.json
└── public/
    ├── index.html       skallen: <main id="app"> + bundmenu
    ├── css/style.css    alle farver og afstande som variabler øverst
    └── js/
        ├── app.js       skærmene 01–11, navigation og knapper
        ├── api.js       kald til vores egen server
        ├── weather.js   Open-Meteo: vejr, bysøgning, geolokalisering
        ├── clothing.js  tøjmotoren (reglerne for tøjråd)
        └── icons.js     streg-ikoner til vejr og tøj (inline SVG)
```

## Skærme (følger wireframes 01–11)

| Adresse | Skærm |
|---|---|
| `#/velkommen` | 01 Velkommen / lokation |
| `#/sog` | 02 Søg efter by (`#/sog?tilfoej=1` gemmer et nyt sted) |
| `#/` | 03 Forside (gæst) / 09 Personlig forside |
| `#/opret` | 04 Opret profil |
| `#/login` | 05 Log ind |
| `#/onboarding/1–3` | 06–08 Onboarding |
| `#/profil` | 10 Profil og præferencer |
| `#/steder` | 11 Gemte steder |

## Sådan opfylder appen kravene

| Krav | Løsning |
|---|---|
| Aktuelt vejr + udsigt for valgt sted | Open-Meteo: nu, time for time og 7 dage. Bysøgning med forslag, mens man skriver |
| Automatisk geolokalisering, hvis brugeren tillader det | "Brug min lokation" (01, 02). Appen forklarer først, hvorfor den spørger. Har man givet lov, bruges positionen automatisk næste gang |
| Generiske tøjråd | Gæster får råd for en voksen med normal kuldefølsomhed (03) |
| Råd efter præferencer og demografi | Alder, kuldefølsomhed (−3°/0°/+3°) og transport (cykel −2°, bil +2°, regnbukser eller paraply) fra onboarding (06–08) |
| Ingen flyverdragt til voksne, medmindre de vælger den | Standardgarderoben afhænger af alder. Flyverdragt, luffer, termobukser og gummistøvler er kun med for "Under 12 år". Voksne kan slå dem til under "Tøj jeg har" (10) |
| Tøjpræferencer ud over standardpaletten | "Tøj jeg har": fravalgt tøj foreslås ikke, og nærmeste alternativ bruges i stedet |
| Gemme brugere, steder, demografi og tøj på serveren | `data/users.json`. Adgangskoder gemmes som scrypt-hash. Steder har navn (Hjem, Campus, Job) og rækkefølge |
| Hentes fra serveren, når brugeren logger ind | Browseren gemmer kun et token. Profilen hentes med `GET /api/me` |
| Registrering for skræddersyede funktioner | Uden profil: generiske råd og ingen gemte steder |
| Visualisering af vejr og tøjråd | Tøjet vist som ikoner, timeoversigt med vejrikoner og regnsøjler, næste dage med tøj og min/max, varsel om skift senere på dagen |

## API

| Metode | Adresse | Funktion |
|---|---|---|
| POST | `/api/register` | Opret profil |
| POST | `/api/login` | Log ind, returnerer et token |
| POST | `/api/logout` | Log ud |
| GET | `/api/me` | Hent bruger og præferencer |
| PUT | `/api/me/profile` | Gem alder, kuldefølsomhed, transport, garderobe, navn |
| DELETE | `/api/me` | Slet profil og alle data |
| POST | `/api/me/locations` | Gem sted |
| PUT | `/api/me/locations/order` | Gem rækkefølgen af steder |
| PUT | `/api/me/locations/:id` | Omdøb sted |
| DELETE | `/api/me/locations/:id` | Fjern sted |

## Forslag til commits i små bidder

1. `Set up Node server serving public/` — server.js (kun statiske filer), index.html, style.css
2. `Add weather data and city search` — weather.js, icons.js, forsiden som gæst, søgning
3. `Add clothing advice engine` — clothing.js og tøjkortet
4. `Add user API with JSON storage` — resten af server.js
5. `Add register, login and onboarding` — api.js, skærm 04–08
6. `Add profile, wardrobe and saved places` — skærm 09–11

## Fravalgt fra wireframes

- **"Fortsæt med Apple/Google"** (markeret *Could*) kræver aftaler med Apple og Google og virker ikke på localhost uden ekstra opsætning.
- **"Glemt adgangskode?"** kræver e-mail, og profilen har ingen e-mail.
