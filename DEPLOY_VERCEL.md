# Deploy Pakistan IDF Atlas to Vercel

This folder contains the Vercel adaptation. No public deployment has been made.
Publishing the **Codex cloud environment** saves its development environment;
it does not publish this website to Vercel.

## 1. Put the files in GitHub

1. Extract the supplied ZIP on your computer.
2. Open `saqibmahmood7117/pakistan-idf-atlas` on GitHub. Its current `main`
   branch contains only a README.
3. Choose **Add file → Upload files** and upload the extracted folder's
   **contents**, including its subfolders. Commit the upload to `main`.

At the repository root, you must see `package.json`, `package-lock.json`,
`vercel.json`, `next.config.ts`, `tsconfig.vercel.json`, `app/`, `lib/`, and
`public/`. Do not upload only the ZIP or place the project inside an extra
wrapper folder. The supplied README replaces the existing README.
You perform this GitHub upload; it has not been done for you.

## 2. Connect Vercel

In Vercel, choose **Add New → Project** and import
`saqibmahmood7117/pakistan-idf-atlas`. Authorize access to that repository if
GitHub asks.

Keep the root directory at the repository root. Select **Node.js 24.x** in
the project's build settings. The checked runtime is Node 24.19.0; the project
requires Node 22.13 or newer.

The included `vercel.json` supplies these settings:

| Setting | Value |
| --- | --- |
| Framework | Next.js |
| Install command | `npm ci` |
| Build command | `next build --webpack` |
| Output directory | `.next` |
| Development command | `next dev` |

No application secrets or database are needed for the included website features.

## 3. Deploy and check the website

Click **Deploy**. Importing the `main` branch normally creates a Production
deployment. Vercel supplies the public website address after the build succeeds.

Open that address. Check that the page loads, a gauge workbook
can be imported, IDF results can be generated, and an Excel result can be
downloaded. Check the deployment logs if a step fails.

Later commits to `main` deploy automatically. To review future changes before
production, push them on another branch and use Vercel's Preview deployment.
Vercel controls the public URL, domain settings, and deployment access.

## Local commands

From the extracted project folder:

```bash
npm ci
npx next dev
```

For a production build and local server:

```bash
npx next build --webpack
npx next start
```

`npm run build` remains the original Cloudflare/Vinext build. Vercel overrides
it with the build command in `vercel.json`.

## Validation of this package

The prepared copy was checked on Node.js 24.19.0:

- Locked dependency installation completed without changing the lockfile.
- `next build --webpack` passed, including strict TypeScript checking and route generation.
- 35 selected existing analytical/workbook tests passed. Seven tests tied to
  the original Worker artifact or missing Windows bundle were excluded from
  that selected run.
- The local production homepage, bundled fonts/CSS/JavaScript, 160-district API,
  labelled screening IDF response, invalid-coordinate rejection, and local
  boundary file passed functional checks.
- Headless Chromium imported a synthetic 30-year daily CSV containing 10,957
  records, generated IDF results and the report, exported Excel data, and
  switched source workspaces without uncaught browser script errors.

These checks used a local production server. They do not establish that a
deployment has occurred in your Vercel account. Live provider calls were not
validated against Vercel infrastructure.

## Known limitations

- The supplied source omits the Windows offline wheels and installer ZIP. The
  website's Windows installer download link will not work until that archive
  is supplied. This does not prevent the main website from building.
- Live climate and watershed services have their own availability and request
  limits. Four provider routes request a 300-second function duration; your
  Vercel plan and settings must support it. Long requests may still exceed
  this duration. These live workflows have not been fully validated on Vercel.
- The original Cloudflare test run executed 42 tests: 40 passed and 2 failed.
  The failures concern the missing Windows offline bundle and an obsolete
  `codex-preview` metadata expectation. This is not a fully passing test suite,
  and it does not establish Vercel production readiness.
- The original GitHub CI workflows retain Cloudflare/Windows targets and can
  show these failures. Their status is separate from the Vercel build result.
