# Klädd - hvad skal du have på i dag?

En vejrapp med tøjråd!

## Kom i gang

```bash
npm start          # eller: npm run dev  (genstarter selv, når server.js ændres)
```

Åbn <http://localhost:3000>.

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