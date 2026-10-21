# Windows: GitHub and Claude Code, step by step

Product display name: **JarcTech Ticket**. Suggested GitHub repository name: **JarcTech-Ticket**.

## 1. Create the repository on GitHub

On GitHub choose New repository. Name it `JarcTech-Ticket`. Choose Private if the company code should be private. Start with an **empty** repository: do not add a README, license, or .gitignore on GitHub because the package already contains project files. Create it and copy its HTTPS repository URL.

If you already initialized a README on GitHub, use the clone method in step 4 instead of trying to overwrite history.

## 2. Extract the ZIP

Extract `JarcTech-Ticket.zip` to a normal project location such as `C:\Projects`. Find the folder containing `README.md`, `CLAUDE.md`, `package.json`, and `public`.

The examples below assume that folder is `C:\Projects\JarcTech-Ticket`. Adjust it if your extraction tool adds an extra outer folder. Do not upload the unopened ZIP as the source code.

## 3. Install or verify tools

Install Node.js 22 or newer from [nodejs.org](https://nodejs.org/) and Git for Windows from [git-scm.com](https://git-scm.com/downloads/win) if needed. Then open PowerShell and run:

```powershell
node --version
npm.cmd --version
git --version
```

Install Claude Code using the official PowerShell command if it is not installed:

```powershell
irm https://claude.ai/install.ps1 | iex
```

Open a new PowerShell window after installation:

```powershell
claude --version
```

Source: [Claude Code official setup](https://code.claude.com/docs/en/setup), checked 21 October 2026. If installation changes, follow the official page.

## 4. Connect your extracted project to GitHub

### If you created an empty repository

In PowerShell, go to the extracted project root:

```powershell
cd C:\Projects\JarcTech-Ticket
npm.cmd run check
npm.cmd test
git init -b main
git add .
git commit -m "Initial JarcTech Ticket prototype"
```

If Git asks for author identity, set your actual name and email for this repository, then repeat the commit:

```powershell
git config user.name "YOUR NAME"
git config user.email "YOUR GITHUB EMAIL"
```

Add your copied HTTPS URL. Replace `YOUR-USERNAME` with your account or organization:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/JarcTech-Ticket.git
git push -u origin main
```

Complete the GitHub browser sign-in if prompted. Reload the repository page; the code, docs, and workflow should be visible.

### If the repository already has a README or other commits

Clone it into a **new folder** instead:

```powershell
cd C:\Projects
git clone https://github.com/YOUR-USERNAME/JarcTech-Ticket.git JarcTech-Ticket-repo
```

Copy the extracted package's contents into that cloned folder, including `.gitignore` and `.github`, while keeping its existing `.git` folder. Review any overlapping files. Then:

```powershell
cd C:\Projects\JarcTech-Ticket-repo
git status
git add .
git commit -m "Add JarcTech Ticket prototype"
git push
```

Do not force push to solve an existing-history mismatch. Source: [GitHub's local-code guide](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github?platform=windows).

## 5. Run the prototype

In the repository folder:

```powershell
npm.cmd start
```

Open http://localhost:4175. Leave that terminal running. If the port is occupied, stop this command and run:

```powershell
$env:PORT = '4176'
npm.cmd start
```

Open the new printed URL. The app needs no dependency installation at this stage.

## 6. Open Claude Code in the same repository

Open a second PowerShell window:

```powershell
cd C:\Projects\JarcTech-Ticket
git switch -c feature/baseline-review
claude
```

Use your actual repository path if you used the clone method. Complete Claude's sign-in flow. GitHub authentication and Claude authentication are separate. Local Claude Code can work directly with the cloned Git repository; no GitHub app connection is required for basic edits and Git pushes.

First prompt:

```text
This project is JarcTech Ticket. Read CLAUDE.md, README.md,
docs/REFERENCE-CHANGES.md, and docs/BUILD-PLAN.md.
Run the existing checks and explain what is already implemented.
Start Phase 1 only: improve code organization without changing
the approved UI or workflow. Preserve existing browser data.
Keep the current request form fields. Do not deploy yet.
```

If you prefer Claude Code on the web rather than the local CLI, connect the GitHub repository through its repository picker and authorize the intended repository. Localhost preview steps above apply to the local CLI workflow.

## 7. Save the first Claude change

After reviewing the change and testing:

```powershell
npm.cmd run check
npm.cmd test
git diff
git add .
git commit -m "Refactor prototype baseline"
git push -u origin feature/baseline-review
```

Open GitHub and use Compare & pull request for that branch. Review and merge it. Continue one phase at a time using BUILD-PLAN.md.

## Common issues

- **npm.ps1 cannot be loaded**: use `npm.cmd`, as shown above.
- **Node or Git not recognized**: reopen PowerShell after installation and re-run the version command.
- **Port already in use**: choose another PORT; avoid stopping an unrelated app.
- **Wrong folder**: `Get-ChildItem` should show package.json before running npm commands.
- **Permission denied when pushing**: confirm the GitHub account has write access and complete GitHub authentication.
- **Non-fast-forward rejection**: stop and inspect remote history; use the clone approach for a repository that already contains commits. Do not force push.
- **Data differs between two URLs**: browser storage belongs to an origin. `localhost:4175`, `127.0.0.1:4175`, and `localhost:4176` do not share records.
