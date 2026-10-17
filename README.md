# GoldenHour

Real-time emergency coordination for the first critical hour. A bystander reports an emergency; dispatch sees it instantly, auto-ranks hospitals by **capability match, bed availability and travel time**, assigns the nearest free ambulance and sends a **pre-arrival alert**. The hospital accepts or declines (decline re-routes), the ambulance streams its position, and a 60-minute golden-hour countdown runs on every screen.

**Live demo:** https://goldenhour-46131.web.app

## Roles (tabs)

| Tab | What it does |
|---|---|
| Report | One-screen SOS: type, severity, patients, GPS or preset location, live status and map after sending |
| Dispatch | Live incident board, hospital recommendations, dispatch, re-route, close case |
| Ambulance | Assigned job, simulated drive to scene then hospital, live position updates |
| Hospital | Inbound alerts with pre-arrival brief, accept/decline, bed count, diversion toggle |

## Stack

- React + TypeScript + Vite, Leaflet / OpenStreetMap
- Cloud Firestore (real-time listeners) and Firebase Hosting, on the free Spark plan (no billing account)
- Domain logic in `web/src/lib/triage.ts`, unit-tested with Vitest

## Run locally

```bash
cd web
npm install
npm run dev      # http://localhost:5173
npm test
npm run build
```

Deploy (needs Firebase CLI and project access): `firebase deploy --only firestore:rules,hosting`

## Honest limitations

- **Demo data:** hospitals, capabilities, bed counts and ambulance units are illustrative seed data with approximate coordinates, not real systems.
- **No authentication:** `firestore.rules` allows public reads and shape-validated writes. This is fine for a demo, not for real emergencies. Add Firebase Auth with role claims before any real use.
- **Simulated driving:** the ambulance moves along a straight line, not a routed road path.
- **No backend server:** Cloud Run / Cloud Functions need a billing account, so all logic runs in the client. This is why the original FastAPI plan was dropped.
- **Not a substitute for 112** or any official emergency service.
