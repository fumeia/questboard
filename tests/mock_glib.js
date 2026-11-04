import fs from 'fs';
const dir = () => process.env.QB_DIR;
export default {
  build_filenamev: a => a.join('/'), get_user_data_dir: () => dir(),
  file_get_contents: p => { if (!fs.existsSync(p)) throw new Error('NOENT'); return [true, fs.readFileSync(p)]; },
  file_set_contents: (p, s) => fs.writeFileSync(p, s), mkdir_with_parents: d => fs.mkdirSync(d, {recursive: true}),
  rename: (a, b) => fs.renameSync(a, b),
  timeout_add: () => 1, source_remove: () => {}, PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
};
