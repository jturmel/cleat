# cleat

Cleat is a task-aware AI CLI plugin focused on helping agents discover, explain, recommend, and run project workflows defined in `Taskfile.yml`.

## What it does

- exposes task-focused tools for listing, explaining, recommending, and running go-task tasks
- parses `Taskfile.yml` and included taskfiles to build task metadata
- helps guide Makefile-to-go-task migration workflows
- injects bootstrap guidance through `experimental.chat.system.transform`
- caches generated bootstrap content per session
- keeps runtime task-routing reinforcements as hidden session prompts

## Development

Install dependencies:

```bash
npm ci
```

Build the plugin:

```bash
npm run build
```

Run tests:

```bash
npm test
```
