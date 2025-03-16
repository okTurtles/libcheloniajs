#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

// Process a directory recursively, renaming files as needed

const extMap = {
  esm: {
    '.d.ts': '.d.mts',
    '.js': '.mjs'
  },
  umd: {
    '.d.ts': '.d.cts',
    '.js': '.cjs'
  }
}

function processDirectory (dir, ext) {
  fs.readdir(dir, { withFileTypes: true }).then((entries) => {
    return Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        // Recursively process subdirectories
        return processDirectory(fullPath, ext)
      } else if (entry.isFile() && Object.keys(ext).some(e => entry.name.endsWith(e))) {
        // Generate the new file name
        const curExt = Object.keys(ext).find(e => entry.name.endsWith(e))
        const newExt = ext[curExt]
        const newFullPath = fullPath.slice(0, -curExt.length) + newExt

        if (ext['.js']) {
          const jsNewExt = ext['.js']
          await fs.readFile(fullPath, { encoding: 'utf8' }).then((content) => {
            const newContent = content
              .replace(/(?<=".*)\.js(?=")/g, jsNewExt)
              .replace(/(?<='.*)\.js(?=')/g, jsNewExt)
            return fs.writeFile(fullPath, newContent)
          })
        }

        await fs.rename(fullPath, newFullPath).catch((err) => {
          console.error(`Error renaming ${fullPath} to ${newFullPath}:`, err)
        })
      }

      return null
    }))
  }).catch(err => {
    console.error(`Error reading directory ${dir}:`, err)
  })
}

if (process.argv[2] === 'esm') {
  processDirectory('./dist/esm', extMap.esm)
} else if (process.argv[2] === 'umd') {
  processDirectory('./dist/umd', extMap.umd)
} else {
  console.error('Invalid dist output')
}
