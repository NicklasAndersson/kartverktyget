# Bygga `sweden-lm.pmtiles` på en fjärrserver

PMTiles-bygget för Lantmäteriets Topografi 10 kräver mer disk (≈25 GB stage +
≈10 GB output) och CPU än de flesta utvecklingslaptops vill avvara. Den här
guiden beskriver hur bygget körs på en hyrd Linux-server och hur den färdiga
PMTiles-filen hämtas hem.

Dagens flöde drivs av två skript:

| Skript | Var den kör | Vad den gör |
|---|---|---|
| [scripts/build-lm-pmtiles.sh](../../scripts/build-lm-pmtiles.sh) | På servern | Den faktiska pipelinen: unzip → ogr2ogr → tippecanoe → tile-join → pmtiles convert. Idempotent. |
| [scripts/build-lm-pmtiles-remote.sh](../../scripts/build-lm-pmtiles-remote.sh) | Lokalt | Synkar script + rådata till servern, kör bygget under `nohup`, följer loggen, hämtar hem resultatet. |

> Hela förvalsprocessen — `apt-get install gdal-bin tippecanoe …` och nedladdning
> av `pmtiles` CLI — sköts av wrappern, så servern behöver bara vara en färsk
> Ubuntu/Debian med SSH-nyckel utlagd för konfigurerad användare.

## Krav

### Lokalt
- `ssh`, `scp`, `rsync` (standard på macOS/Linux)
- SSH-nyckel som är auktoriserad på fjärrservern (default: `~/.ssh/id_*` via
  ssh-agent)
- Råleveransen från Lantmäteriet under
  `data/raw/lantmäteriet/<uttagsidentitet>/` (≈11 GB)

### Servern
- Ubuntu/Debian 22.04+ (eller annan distro där `apt-get` finns)
- Minst **40 GB** ledig disk (rådata 11 GB + stage 15–20 GB + output 8–12 GB)
- 4 GB RAM är minimum, 8 GB+ rekommenderas (tippecanoe stora lager)
- Root-access via SSH-nyckel
- Internet-access (för `apt-get` + GitHub-nedladdning av `pmtiles` CLI)

En Hetzner CX22 / CX32 eller motsvarande räcker. Default-värdena i wrappern
pekar mot servern `178.105.223.176` som root.

## Konfiguration

Kopiera mallen [`.env.example`](../../.env.example) till `.env` i repo-roten
och fyll i värdena. Wrappern och upload-skriptet läser båda samma `.env`.
Relevanta fält:

```env
LM_REMOTE_HOST=178.105.223.176
LM_REMOTE_USER=root
LM_REMOTE_DIR=/root/kvg
LM_RAW_DIR=data/raw/lantmäteriet/bb7631cc-81ee-4bd0-aa8b-2a23714cb259
LM_OUT_PMTILES=data/sweden-lm.pmtiles
# Valfritt: ange nyckel om du inte använder ssh-agent
# LM_SSH_OPTS=-i ~/.ssh/hetzner_ed25519
```

## Första bygget

```bash
# Snabb prototyp (Stockholms-bbox, ~5 min på 8 vCPU):
./scripts/build-lm-pmtiles-remote.sh --bbox=17.7,59.2,18.3,59.5

# Fullt Sverige-bygge (timmar):
./scripts/build-lm-pmtiles-remote.sh
```

Wrappern gör i tur och ordning:

1. **Verifiera SSH** och installera saknade verktyg (`gdal-bin`, `tippecanoe`,
   `pmtiles`, `unzip`, `jq`).
2. **Synka script** (`rsync` av `scripts/build-lm-pmtiles.sh`).
3. **Synka rådata** (`rsync --partial --progress` av `data/raw/lm/`). Återupptar
   automatiskt avbrutna överföringar.
4. **Starta bygget** under `nohup` så det överlever SSH-tapp. PID och logg
   skrivs till `/root/kvg/logs/`.
5. **Följa loggen** med `tail -f --pid=$PID`. Bryt med Ctrl+C — bygget
   fortsätter på servern och kan följas igen med `--skip-upload`.
6. **Hämta hem** `data/sweden-lm.pmtiles` med `rsync --partial`.

## Periodiska uppdateringar

Topografi 10 uppdateras veckovis. För att rebuilda med ny leverans:

1. Lägg den nya leveransen i `data/raw/lantmäteriet/<ny-uttagsidentitet>/` och
   uppdatera `LM_RAW_DIR` i `.env`.
2. Kör bygget om från noll så att gammal stage-data inte återanvänds:

   ```bash
   ./scripts/build-lm-pmtiles-remote.sh --no-resume
   ```

   `--no-resume` rensar `data/stage/lm/` och tidigare `sweden-lm.pmtiles` på
   servern innan bygget startas.

3. Efter att den nya `data/sweden-lm.pmtiles` är hemma — deploya den till
   den CDN/origin som webben/API:t pekar mot. Tile-proxyn i
   [apps/api/src/tiles.ts](../../apps/api/src/tiles.ts) plockar upp namnet
   automatiskt så snart filen ligger i `data/`.

### Inkrementella leveranser (framtida automatisering)

Geotorget kan abonnera på inkrementella veckoleveranser. Pipelinen är dock
inte inkrementell ännu — varje uppdatering kräver fullt bygge. När
abonnemangsflödet automatiseras bör steg 1 i
[scripts/build-lm-pmtiles.sh](../../scripts/build-lm-pmtiles.sh) (kommenterat
ut idag) implementeras så att råleveransen hämtas direkt på servern via
OAuth2-tokenflödet, och cron triggar wrappern.

## Felsökning

### Återanslut till pågående bygge

Wrappern skriver pid och senaste logg till `/root/kvg/logs/`. Om SSH dör eller
du behöver gå hemifrån:

```bash
./scripts/build-lm-pmtiles-remote.sh --skip-upload
```

Detta upptäcker en levande pid och börjar följa samma logg igen istället för
att starta om bygget.

### Inspektera utan att bygga

```bash
./scripts/build-lm-pmtiles-remote.sh --skip-upload -- --inventory
```

Allt efter `--` skickas vidare till `build-lm-pmtiles.sh`. `--inventory` kör
`ogrinfo` mot varje uppackad GeoPackage och avslutar — användbart för att
verifiera tabell- och attributnamn innan stilfilen färdigställs.

### Tvinga om enskilda steg

```bash
./scripts/build-lm-pmtiles-remote.sh --skip-upload -- --force-stage=mvt
```

Giltiga steg: `unzip`, `geojson`, `mvt`, `join`, `pmtiles`.

### Diskbrist

Om `df -h /` på servern visar mindre än ~40 GB ledigt: rensa gamla stage-
filer manuellt.

```bash
ssh root@$LM_REMOTE_HOST 'du -sh /root/kvg/data/stage/lm/* | sort -h'
ssh root@$LM_REMOTE_HOST 'rm -rf /root/kvg/data/stage/lm'
```

`--no-resume` gör samma sak automatiskt.

### Snapshot, paus och resume

Hela bygget tar timmar. För att inte betala för servern över natten:

1. **Stoppa bygget rent** (per-lager-mbtiles är redan färdiga och återanvänds):

   ```bash
   ssh root@$LM_REMOTE_HOST 'pkill -TERM -f build-lm-pmtiles; \
     pkill -TERM tippecanoe tile-join pmtiles; sync'
   ```

2. **Ta snapshot** i Hetzner Cloud Console → server → Snapshots.
3. **Radera servern** — snapshoten finns kvar och kostar några öre/dag.
4. När du vill fortsätta: skapa ny server från snapshoten. IP blir ny;
   uppdatera `LM_REMOTE_HOST` i `.env`.

Efter restore får servern ny SSH-hostkey, så lokala `~/.ssh/known_hosts`
matchar inte längre. Rensa och acceptera den nya:

```bash
ssh-keygen -R "$LM_REMOTE_HOST"
ssh -o StrictHostKeyChecking=accept-new root@$LM_REMOTE_HOST 'hostname'
```

Ofullständiga sammansatta filer (`sweden-lm.mbtiles`,
`sweden-lm.pmtiles`) måste raderas så skriptet kör om de etapperna —
per-lager-mbtiles behålls och hoppas över:

```bash
ssh root@$LM_REMOTE_HOST 'rm -f /root/kvg/data/stage/lm/sweden-lm.mbtiles* \
  /root/kvg/data/sweden-lm.pmtiles'
./scripts/build-lm-pmtiles-remote.sh --skip-upload
```

`--skip-upload` hoppar över rsync av råleveransen (den ligger redan på
snapshoten).

### Långsam överföring

Första uppladdningen av 11 GB rådata är typiskt 30–90 minuter beroende på
uppströmsbandbredd. Använd `--skip-upload` på efterföljande körningar om
rådatan inte ändrats. För dataset som ofta uppdateras kan rådatan istället
hämtas direkt på servern via Lantmäteriets API (kräver klient-credentials,
se [lantmateriet-topografi10.md](lantmateriet-topografi10.md#datapipeline)).

## Publicera till Backblaze B2

Webbappen läser PMTiles direkt över HTTP via `pmtiles://`-protokollet. Den
färdiga `sweden-lm.pmtiles` laddas upp till bucket `kartverktyget` (S3-API,
`eu-central-003`) med [scripts/upload-pmtiles-b2.sh](../../scripts/upload-pmtiles-b2.sh).

Skriptet använder aws-cli (`brew install awscli`), multipart 128 MB,
8 parallella delar, och sanity-checkar headern med `pmtiles show` innan
upload.

Konfigurera credentials i `.env` (se [`.env.example`](../../.env.example) —
fälten `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT`,
`B2_REGION`). Skapa en bucket-specifik application key i B2-konsolen med
write-access mot just `kartverktyget`.

> **OBS stavning:** bucket-namnet är `kartverktyget` (med *rk*), inte
> `kartvertyget` (som repot heter). Fel stavning ger `403`/`404` på upload.

```bash
# Variant A: ladda upp från servern (snabbast — slipper 30 GB nedladdning)
scp scripts/upload-pmtiles-b2.sh .env root@$LM_REMOTE_HOST:/root/kvg/
ssh root@$LM_REMOTE_HOST 'cd /root/kvg && ./scripts/upload-pmtiles-b2.sh'

# Variant B: hämta hem och ladda upp lokalt
# (förutsätter att build-lm-pmtiles-remote.sh redan har rsynkat hem filen)
./scripts/upload-pmtiles-b2.sh
```

Default objektnyckel är `sweden-lm.pmtiles`. Verifiera att fildelen finns:

```bash
curl -sI -r 0-127 \
  https://kartverktyget.s3.eu-central-003.backblazeb2.com/sweden-lm.pmtiles \
  | head -5
```

Stilen [`apps/web/public/styles/lantmateriet-topo10.json`](../../apps/web/public/styles/lantmateriet-topo10.json)
pekar mot denna URL via `pmtiles://`-prefix och slår igenom direkt så snart
filen är ersatt — ingen deploy av appen krävs.

## Bygget i drift

Loggen sparas på servern under `/root/kvg/logs/build-YYYYMMDD-HHMMSS.log` och
roteras inte automatiskt. Rensa periodvis med t.ex.:

```bash
ssh root@$LM_REMOTE_HOST 'find /root/kvg/logs -name "build-*.log" -mtime +30 -delete'
```

Den färdiga `data/sweden-lm.pmtiles` är gitignored
(se [.gitignore](../../.gitignore)) och distribueras via CDN/objektlagring —
versionera inte i repo:t.
