# Publishing @fabricate-tools/client

## Prerequisites

1. You must be logged into npm with an account that has publish access to `@fabricate-tools/client`:
   ```bash
   npm login
   ```

2. Ensure you have the latest dependencies installed:
   ```bash
   yarn install
   ```

## Publishing Steps

### 1. Update the version

Update the `version` field in `package.json` following [semver](https://semver.org/):
- **Patch** (1.3.1 → 1.3.2): Bug fixes, no API changes
- **Minor** (1.3.1 → 1.4.0): New features, backwards compatible
- **Major** (1.3.1 → 2.0.0): Breaking changes

### 2. Test the build

```bash
yarn build
```

Verify the `dist/` folder contains the compiled JavaScript and TypeScript declaration files.

### 3. Test locally (optional)

Run the example scripts to verify everything works:
```bash
yarn test:agent:download
yarn test:agent:workflow
```

### 4. Publish

Run the release script:
```bash
yarn release
```

This will:
1. Clean the `dist/` folder
2. Compile TypeScript to JavaScript
3. Publish to npm with public access

### 5. Verify

Check that the package was published:
```bash
npm view @fabricate-tools/client
```

## Manual Publishing

If you need to publish manually:

```bash
# Clean and build
yarn clean
yarn build

# Publish
npm publish --access public
```

## Troubleshooting

### "You must be logged in to publish packages"
Run `npm login` and authenticate with your npm account.

### "You do not have permission to publish"
Contact an npm org admin to be added to the `@fabricate-tools` organization.

### "Cannot publish over previously published version"
Update the version number in `package.json` - you cannot republish the same version.
