/**
 * vite-plugin-init-resources.ts
 *
 * Al arrancar `npm run dev` o `npm run build`, lee public/data/global-bank.json
 * y garantiza que resources/[slug]/ existe para cada asignatura.
 *
 * ⚠️  Nunca sobreescribe archivos existentes.
 *
 * También expone (solo en dev) endpoints para:
 * - POST /api/upload-pdf: guardar PDFs en resources/[slug]/Temas/
 * - POST /api/sync-pdf-mapping: sincronizar el index.json de Temas
 * - POST /api/upload-resource: guardar recursos en Examenes/Resumenes/Practica y generar index.json
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

// ─── Slug (idéntico a slugify en src/domain/normalize.ts) ────────────────────

function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ─── Core ─────────────────────────────────────────────────────────────────────

function initResources(root: string): void {
  const resourcesDir = path.join(root, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });

  const candidatePaths = [
    path.join(root, 'public', 'data', 'global-bank.json'),
    path.join(root, 'src',    'data', 'global-bank.json'),
    path.join(root, 'data',   'global-bank.json'),
    path.join(root,            'global-bank.json'),
  ];

  const bankPath = candidatePaths.find(p => fs.existsSync(p));

  if (!bankPath) {
    console.log(
      '\x1b[33m[init-resources]\x1b[0m ℹ️  No se encontró global-bank.json.\n' +
      '              Exporta el banco desde la app y guárdalo en public/data/global-bank.json'
    );
    return;
  }

  console.log(`\x1b[36m[init-resources]\x1b[0m 📄 Banco encontrado: ${path.relative(root, bankPath)}`);

  let bank: { subjects?: Array<{ name: string }> };
  try {
    bank = JSON.parse(fs.readFileSync(bankPath, 'utf-8'));
  } catch (e) {
    console.error('\x1b[31m[init-resources]\x1b[0m ❌ Error al parsear global-bank.json:', e);
    return;
  }

  if (!Array.isArray(bank?.subjects)) {
    console.warn('\x1b[33m[init-resources]\x1b[0m ⚠️  El banco no tiene un array "subjects"');
    return;
  }

  if (bank.subjects.length === 0) {
    console.log('\x1b[33m[init-resources]\x1b[0m ⚠️  El banco no tiene asignaturas aún');
    return;
  }

  console.log(`\x1b[36m[init-resources]\x1b[0m 📚 ${bank.subjects.length} asignatura(s) encontradas`);

  let created = 0;

  for (const subject of bank.subjects) {
    if (!subject.name) continue;

    const slug       = slugify(subject.name);
    const subjectDir = path.join(resourcesDir, slug);
    const temasDir   = path.join(subjectDir, 'Temas');

    fs.mkdirSync(subjectDir, { recursive: true });
    fs.mkdirSync(temasDir,   { recursive: true });

    const extraInfoPath = path.join(subjectDir, 'extra_info.json');
    if (!fs.existsSync(extraInfoPath)) {
      fs.writeFileSync(
        extraInfoPath,
        JSON.stringify({ allowsNotes: false, professor: '', credits: 6, description: '', pdfs: [] }, null, 2) + '\n',
        'utf-8'
      );
      console.log(`\x1b[36m[init-resources]\x1b[0m ✅ ${slug}/extra_info.json`);
      created++;
    }

    const indexPath = path.join(temasDir, 'index.json');
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, '[]\n', 'utf-8');
      console.log(`\x1b[36m[init-resources]\x1b[0m ✅ ${slug}/Temas/index.json`);
      created++;
    }
  }

  if (created === 0) {
    console.log('\x1b[36m[init-resources]\x1b[0m ✓ resources/ ya está al día');
  } else {
    console.log(`\x1b[36m[init-resources]\x1b[0m 📁 ${created} archivo(s) creado(s)`);
  }
}

// ─── Auto-sync resource indexes ───────────────────────────────────────────────

/**
 * Escanea resources/[slug]/[Categoria]/ y regenera index.json con los archivos
 * reales del disco. Se ejecuta en cada arranque (dev y build).
 * Categorías gestionadas: Resumenes, Examenes, Practica.
 * Los subdirectorios dentro de una categoría se tratan como subcategorías.
 */
function syncResourceIndexes(root: string): void {
  const resourcesDir = path.join(root, 'resources');
  if (!fs.existsSync(resourcesDir)) return;

  const MANAGED_CATEGORIES = ['Resumenes', 'Examenes', 'Practica'];
  const SKIP_FILES = ['index.json', '.DS_Store', 'Thumbs.db'];

  // Extensiones → tipo legible
  const extType = (filename: string): string =>
    filename.split('.').pop()?.toLowerCase() ?? 'file';

  let updated = 0;

  const subjectDirs = fs.readdirSync(resourcesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const subjectSlug of subjectDirs) {
    for (const cat of MANAGED_CATEGORIES) {
      const catDir = path.join(resourcesDir, subjectSlug, cat);
      if (!fs.existsSync(catDir)) continue;

      interface ResourceFile { name: string; path: string; type: string; }
      interface SubCategory { name: string; files: ResourceFile[]; }
      interface IndexData { files: ResourceFile[]; subcategories: SubCategory[]; }

      const indexData: IndexData = { files: [], subcategories: [] };

      const entries = fs.readdirSync(catDir, { withFileTypes: true });

      for (const entry of entries) {
        if (SKIP_FILES.includes(entry.name)) continue;

        if (entry.isFile()) {
          indexData.files.push({
            name: entry.name,
            path: entry.name,
            type: extType(entry.name),
          });
        } else if (entry.isDirectory()) {
          // Subdirectorio → subcategoría
          const subDir = path.join(catDir, entry.name);
          const subFiles: ResourceFile[] = fs.readdirSync(subDir, { withFileTypes: true })
            .filter(f => f.isFile() && !SKIP_FILES.includes(f.name))
            .map(f => ({
              name: f.name,
              path: f.name,
              type: extType(f.name),
            }));

          if (subFiles.length > 0) {
            indexData.subcategories.push({ name: entry.name, files: subFiles });
          }
        }
      }

      const indexPath = path.join(catDir, 'index.json');
      const newContent = JSON.stringify(indexData, null, 2) + '\n';

      // Solo escribir si cambió (evita recargas innecesarias en HMR)
      const oldContent = fs.existsSync(indexPath)
        ? fs.readFileSync(indexPath, 'utf-8')
        : null;

      if (oldContent !== newContent) {
        fs.writeFileSync(indexPath, newContent, 'utf-8');
        updated++;
        console.log(`\x1b[36m[init-resources]\x1b[0m 🔄 ${subjectSlug}/${cat}/index.json (${indexData.files.length} archivos, ${indexData.subcategories.length} subcats)`);
      }
    }
  }

  if (updated === 0) {
    console.log('\x1b[36m[init-resources]\x1b[0m ✓ resource indexes ya están al día');
  }
}

// ─── PDF upload endpoint (dev only) ──────────────────────────────────────────

function registerUploadEndpoint(server: import('vite').ViteDevServer, root: string): void {
  server.middlewares.use('/api/upload-pdf', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const { slug, filename, data } = JSON.parse(body) as {
          slug: string;
          filename: string;
          data: string; // base64
        };

        if (!slug || !filename || !data) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Faltan campos: slug, filename, data' }));
          return;
        }

        // Sanity check: no path traversal
        const safeName = path.basename(filename);
        const safeSlug = slugify(slug);

        const temasDir = path.join(root, 'resources', safeSlug, 'Temas');
        fs.mkdirSync(temasDir, { recursive: true });

        // Escribir el PDF
        const pdfPath = path.join(temasDir, safeName);
        fs.writeFileSync(pdfPath, Buffer.from(data, 'base64'));
        console.log(`\x1b[36m[init-resources]\x1b[0m 📥 PDF guardado: resources/${safeSlug}/Temas/${safeName}`);

        // Actualizar index.json
        const indexPath = path.join(temasDir, 'index.json');
        let index: string[] = [];
        if (fs.existsSync(indexPath)) {
          try {
            index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          } catch {
            index = [];
          }
        }
        if (!index.includes(safeName)) {
          index.push(safeName);
          fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
          console.log(`\x1b[36m[init-resources]\x1b[0m 📝 index.json actualizado: [${index.join(', ')}]`);
        }

        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, filename: safeName, index }));
      } catch (e) {
        console.error('\x1b[31m[init-resources]\x1b[0m ❌ Error en upload:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  });
}

// ─── PDF mapping sync endpoint (dev only) ────────────────────────────────────

function registerSyncMappingEndpoint(server: import('vite').ViteDevServer, root: string): void {
  server.middlewares.use('/api/sync-pdf-mapping', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return; }

    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const { slug, entries } = JSON.parse(body) as {
          slug: string;
          entries: Array<{ topicTitle: string; pdf: string }>;
        };

        if (!slug || !Array.isArray(entries)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Faltan campos: slug, entries' }));
          return;
        }

        const safeSlug = slugify(slug);
        const temasDir = path.join(root, 'resources', safeSlug, 'Temas');
        fs.mkdirSync(temasDir, { recursive: true });

        const indexPath = path.join(temasDir, 'index.json');
        let index: Array<{ topicTitle: string; pdf: string }> = [];
        if (fs.existsSync(indexPath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            index = Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string'
              ? (raw as string[]).map(pdf => ({ topicTitle: '', pdf }))
              : raw;
          } catch { index = []; }
        }

        // Merge: actualizar entradas existentes, añadir nuevas
        for (const entry of entries) {
          if (!entry.pdf) continue;
          const idx = index.findIndex(e => e.pdf === entry.pdf);
          if (idx >= 0) {
            index[idx] = entry;
          } else {
            index.push(entry);
          }
        }

        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
        console.log(`\x1b[36m[init-resources]\x1b[0m 🔄 index.json sincronizado (${safeSlug}): ${entries.length} entradas`);

        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, index }));
      } catch (e) {
        console.error('\x1b[31m[init-resources]\x1b[0m ❌ Error en sync-mapping:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  });
}

// ─── NEW: Resource upload endpoint for Examenes/Resumenes/Practica (dev only) ─

function registerResourceUploadEndpoint(server: import('vite').ViteDevServer, root: string): void {
  server.middlewares.use('/api/upload-resource', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const { slug, category, path: filePath, data, mime } = JSON.parse(body) as {
          slug: string;
          category: string; // Examenes, Resumenes, Practica
          path: string;     // Ruta relativa dentro de la categoría (puede incluir subdirectorios)
          data: string;     // base64
          mime: string;
        };

        if (!slug || !category || !filePath || !data) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Faltan campos: slug, category, path, data' }));
          return;
        }

        const safeSlug = slugify(slug);
        const categoryDir = path.join(root, 'resources', safeSlug, category);
        
        // Crear la estructura de directorios necesaria
        const fullPath = path.join(categoryDir, filePath);
        const dirPath = path.dirname(fullPath);
        fs.mkdirSync(dirPath, { recursive: true });

        // Escribir el archivo
        fs.writeFileSync(fullPath, Buffer.from(data, 'base64'));
        console.log(`\x1b[36m[init-resources]\x1b[0m 📥 Recurso guardado: resources/${safeSlug}/${category}/${filePath}`);

        // Actualizar/crear index.json en la categoría
        const indexPath = path.join(categoryDir, 'index.json');
        
        interface ResourceFile {
          name: string;
          path: string;
          type: string;
        }

        interface SubCategory {
          name: string;
          files: ResourceFile[];
        }

        interface IndexData {
          files: ResourceFile[];
          subcategories?: SubCategory[];
        }

        let indexData: IndexData = { files: [], subcategories: [] };
        
        if (fs.existsSync(indexPath)) {
          try {
            indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            if (!indexData.files) indexData.files = [];
            if (!indexData.subcategories) indexData.subcategories = [];
          } catch {
            indexData = { files: [], subcategories: [] };
          }
        }

        // Determinar si el archivo va en files o en una subcategoría
        const pathParts = filePath.split('/');
        const filename = pathParts[pathParts.length - 1];
        const ext = filename.split('.').pop()?.toLowerCase() ?? '';
        
        if (pathParts.length === 1) {
          // Archivo en la raíz de la categoría
          const existingFileIndex = indexData.files.findIndex(f => f.path === filePath);
          const fileEntry: ResourceFile = {
            name: filename,
            path: filePath,
            type: ext,
          };
          
          if (existingFileIndex >= 0) {
            indexData.files[existingFileIndex] = fileEntry;
          } else {
            indexData.files.push(fileEntry);
          }
        } else {
          // Archivo en subdirectorio - añadir a subcategories
          const subCategoryName = pathParts[0];
          let subCategory = indexData.subcategories!.find(sc => sc.name === subCategoryName);
          
          if (!subCategory) {
            subCategory = { name: subCategoryName, files: [] };
            indexData.subcategories!.push(subCategory);
          }
          
          const relativePathInSubcat = pathParts.slice(1).join('/');
          const existingFileIndex = subCategory.files.findIndex(f => f.path === relativePathInSubcat);
          const fileEntry: ResourceFile = {
            name: filename,
            path: relativePathInSubcat,
            type: ext,
          };
          
          if (existingFileIndex >= 0) {
            subCategory.files[existingFileIndex] = fileEntry;
          } else {
            subCategory.files.push(fileEntry);
          }
        }

        fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2) + '\n', 'utf-8');
        console.log(`\x1b[36m[init-resources]\x1b[0m 📝 ${category}/index.json actualizado`);

        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, path: filePath }));
      } catch (e) {
        console.error('\x1b[31m[init-resources]\x1b[0m ❌ Error en upload-resource:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  });
}

export function initResourcesPlugin(): Plugin {
  let root: string;

  return {
    name: 'init-resources',
    enforce: 'pre',

    configResolved(config) {
      root = config.root;
    },

    buildStart() {
      initResources(root);
      syncResourceIndexes(root);
    },

    configureServer(server) {
      initResources(server.config.root);
      syncResourceIndexes(server.config.root);
      registerUploadEndpoint(server, server.config.root);
      registerSyncMappingEndpoint(server, server.config.root);
      registerResourceUploadEndpoint(server, server.config.root);
      registerQuestionImageUploadEndpoint(server, server.config.root);
      registerWriteGlobalBankEndpoint(server, server.config.root);
    },
  };
}

function registerQuestionImageUploadEndpoint(server: import('vite').ViteDevServer, root: string): void {
  server.middlewares.use('/api/upload-question-image', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return; }

    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const { filename, data, mime } = JSON.parse(body) as {
          filename: string;
          data: string;  // base64
          mime: string;
        };

        if (!filename || !data) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Faltan campos: filename, data' }));
          return;
        }

        // Security: no path traversal
        const safeName = path.basename(filename);
        const imagesDir = path.join(root, 'public', 'question-images');
        fs.mkdirSync(imagesDir, { recursive: true });

        const filePath = path.join(imagesDir, safeName);
        fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
        console.log(`\x1b[36m[init-resources]\x1b[0m 🖼  Imagen guardada: public/question-images/${safeName}`);

        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, filename: safeName }));
      } catch (e) {
        console.error('\x1b[31m[init-resources]\x1b[0m ❌ Error en upload-question-image:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  });
}

function registerWriteGlobalBankEndpoint(server: import('vite').ViteDevServer, root: string): void {
  server.middlewares.use('/api/write-global-bank', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return; }

    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const json = JSON.parse(body);
        const content = JSON.stringify(json, null, 2) + '\n';

        const srcPath = path.join(root, 'src', 'data', 'global-bank.json');
        fs.writeFileSync(srcPath, content, 'utf-8');

        console.log(`\x1b[36m[init-resources]\x1b[0m 🏦 global-bank.json actualizado (${json.questions?.length ?? '?'} preguntas)`);
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('\x1b[31m[init-resources]\x1b[0m ❌ Error escribiendo global-bank.json:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  });
}