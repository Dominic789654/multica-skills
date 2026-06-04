#!/usr/bin/env node

import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_DATASET_MANIFEST_PATH,
  formatDatasetValidationReport,
  readDatasetManifest,
  validateDatasetManifest
} from '../benchmark/golden-dataset.mjs'

const DEFAULT_CASES_PATH = 'benchmark/cases.json'

function parseArgs(argv) {
  const options = {
    casesPath: DEFAULT_CASES_PATH,
    datasetId: null,
    json: false,
    manifestPath: DEFAULT_DATASET_MANIFEST_PATH
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--cases') {
      options.casesPath = argv[++index]
    } else if (arg === '--dataset') {
      options.datasetId = argv[++index]
    } else if (arg === '--manifest') {
      options.manifestPath = argv[++index]
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function usage() {
  return [
    'Usage:',
    '  node scripts/check-golden-dataset.mjs',
    '  node scripts/check-golden-dataset.mjs --dataset merge-gate',
    '',
    'Options:',
    `  --manifest <path>  Golden Dataset manifest path, default ${DEFAULT_DATASET_MANIFEST_PATH}`,
    `  --cases <path>     Benchmark cases path, default ${DEFAULT_CASES_PATH}`,
    '  --dataset <id>     Validate one named dataset only',
    '  --json             Print the full report as JSON'
  ].join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const casesPayload = JSON.parse(readFileSync(path.join(repoRoot, options.casesPath), 'utf8'))
  const manifest = readDatasetManifest(repoRoot, options.manifestPath)
  const report = validateDatasetManifest(casesPayload, manifest, options.datasetId)

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatDatasetValidationReport(report))
  }

  if (report.errors.length > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})