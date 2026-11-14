# Le Betlehem des Anges

Liste de cadeaux familiale pour le 24 décembre (tradition hongroise : les anges apportent les cadeaux).

- `index.html` : l'application famille (accès par lien personnel + code à 4 chiffres choisi à la première ouverture).
- `admin.html#k=<ADMIN_KEY>` : ajouter des personnes, copier leur lien, réinitialiser un accès. Ne montre aucune idée.
- `api/app.js` : API unique. Toutes les règles de secret sont appliquées côté serveur.

## Déploiement (Vercel, sans build)
Variables d'environnement :
- `ADMIN_KEY` : clé de la page d'organisation.
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) : base Upstash Redis.
- `REVEAL_AT` (optionnel) : date de révélation, par défaut `2026-12-24T18:00:00+01:00`.

Toutes les clés Redis sont préfixées par `sapin:`.
