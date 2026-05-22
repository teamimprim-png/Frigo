# Frigo Equipe

Application web locale pour gerer les ventes d'une petite equipe: boissons, friandises, surgeles, credits, stock, remplissage et inventaires.

## Lancer l'application avec Node.js

L'application se lance maintenant avec Node.js et sauvegarde les donnees dans `data/frigo-state.json`.

```bash
npm run dev
```

Puis ouvrir une des pages:

- `http://localhost:4173/kiosque`
- `http://localhost:4173/gestion`

Les deux pages ne sont pas reliees dans l'interface: elles s'ouvrent directement par URL.

Le port peut etre change avec la variable `PORT`.

```bash
PORT=4181 npm run dev
```

Ou avec un argument:

```bash
npm run dev -- 4181
```

## Fonctionnement

- `Kiosque`: selection d'un equipier, ajout des produits consommes, paiement en especes ou mise en credit.
- `Rembourser un credit`: saisie d'un remboursement, qui diminue le credit de l'equipier et augmente la caisse theorique.
- `Gestion`: ajout/modification des produits, equipiers, stock en rayon, reserve et remplissage.
- `Inventaire`: saisie du stock compte, de l'argent compte et du total de la feuille de credit pour calculer les ecarts.
- `Exporter` / `Importer`: sauvegarde ou restauration des donnees au format JSON.
- `Synchronisation`: le badge dans l'en-tete indique si les donnees sont bien sauvegardees par le serveur Node.js.

Le navigateur garde aussi une copie locale de secours, mais la source principale est maintenant le serveur Node.js.
