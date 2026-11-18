// node --import ./tests/ui/loader.mjs: maps gi://X and the shell's resource:/// modules to the stand-ins in this folder.
import {register} from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
const base = ${JSON.stringify(new URL('./', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
    if (spec.startsWith('gi://')) {
        const m = spec.slice(5).split('?')[0];
        return {url: base + 'gi.mjs?m=' + m, shortCircuit: true};
    }
    if (spec.startsWith('resource:///')) {
        const name = spec.split('/').pop().replace('.js', '');
        return {url: base + 'shell.mjs?m=' + name, shortCircuit: true};
    }
    return next(spec, ctx);
}
`));
