import * as Bluebird from 'bluebird';
import * as path from 'path';
import { actions, fs, log, selectors, types, util } from 'vortex-api';

import { IDataArchive } from './types';

const archiveData = [
  {
    gameId: 'skyrim',
    gameName: 'Skyrim (2011)',
    version: 104,
    type: 'BSA',
  },
  {
    gameId: 'skyrimse',
    gameName: 'Skyrim Special Edition',
    version: 105,
    type: 'BSA',
  },
  {
    gameId: 'skyrimvr',
    gameName: 'Skyrim VR',
    version: 105,
    type: 'BSA',
  },
  {
    gameId: 'oblivion',
    gameName: 'Oblivion',
    version: 103,
    type: 'BSA',
  },
  // Commented this out as it'll confuse Skyrim players
  // {
  //   gameId: 'newvegas',
  //   gameName: 'Fallout New Vegas',
  //   version: 104,
  //   type: 'BSA'
  // },
  {
    gameId: 'fallout4',
    gameName: 'Fallout 4',
    version: 1,
    type: 'BA2',
  },
  {
    gameId: 'fallout4vr',
    gameName: 'Fallout 4 VR',
    version: 1,
    type: 'BA2',
  },
  {
    gameId: 'fallout76',
    gameName: 'Fallout 76',
    version: 1,
    type: 'BA2',
  },
];

function main(context: types.IExtensionContext) {
  context.requireExtension('gamebryo-plugin-management');

  context.once(() => {
    // The only way to check AFTER the auto sort is by registering for the following state change.
    context.api.onStateChange(['session', 'plugins', 'pluginInfo'],
      (prev, cur) => checkForErrors(context.api, cur));
  });

  return true;
}

async function checkForErrors(api, pluginsObj): Promise<void> {
  api.dismissNotification('archive-errors');

  // Check this is a game we want to run this check on.
  const state = api.store.getState();
  const activeGameId = selectors.activeGameId(state);
  const gameData = archiveData.find(g => g.gameId === activeGameId);
  if (!gameData) {
    return;
  }

  // Get the plugins for the current game.
  if (!pluginsObj || !Object.keys(pluginsObj)) {
    return;
  }

  const plugins = Object.keys(pluginsObj)
    .map(k => pluginsObj[k])
    .sort((a, b) => a.loadOrder > b.loadOrder ? 1 : -1);

  // We want only enabled plugins that load archives, but aren't base game files.
  const archiveLoaders = plugins.filter(p => !p.isNative && p.loadsArchive && p.enabled === true);

  // Get the list of mods and the data folder path.
  const mods = util.getSafe(state, ['persistent', 'mods', activeGameId], {});
  const discovery = util.getSafe(state,
    ['settings', 'gameMode', 'discovered', activeGameId, 'path'], undefined);

  const dataFolder = discovery ? path.join(discovery, 'data') : undefined;

  try {
    // Read the data folder top level.
    const dataFiles = await fs.readdirAsync(dataFolder);
    // Filter out anything that isn't a BSA/BA2
    const dataArchives = dataFiles.filter(f => ['.ba2', '.bsa'].includes(path.extname(f)));
    const archivesToCheck: IDataArchive[] = archiveLoaders.map((plugin) => {
      const pName: string = plugin.name.replace(path.extname(plugin.name), '').toLowerCase();
      return dataArchives.filter(a => path.basename(a).toLowerCase().startsWith(pName))
                         .map(a => ({ name: a, plugin: plugin.name }));
    }).reduce((prev, cur) => prev.concat(cur), []);

    // If there's nothing to check, we can exit here.
    if (!archivesToCheck.length) {
      return;
    }

    let pos = 0;

    // Updatable notification.
    const progress = (archiveName) => {
      api.store.dispatch(actions.addNotification({
        id: `checking-archives-all`,
        progress: (pos * 100) / archivesToCheck.length,
        title: 'Checking archives',
        message: archiveName,
        type: 'activity',
      }));
      ++pos;
    };

    const issues = await Bluebird.mapSeries(archivesToCheck, async (archive) => {
      progress(archive.name);
      try {
        const version = await streamArchiveVersion(path.join(dataFolder, archive.name));
        if (version === gameData.version) {
          return;
        }

        const plugin = plugins.find(p => p.name === archive.plugin);
        const mod = plugin ? mods[plugin.modName] : undefined;
        return {
          name: archive.name,
          version,
          validVersion: gameData.version,
          plugin,
          mod,
        };

      } catch (err) {
        log('error', 'Error checking BSA versions', err);
        return;
      }
    }).filter(i => !!i);

    // Dismiss our notice.
    api.dismissNotification('checking-archives-all');

    // If we have errors, we'd better say something.
    if (issues.length) {
      api.sendNotification({
        id: 'archive-errors',
        type: 'error',
        group: 'archive-errors',
        title: 'Incompatible mod archive(s)',
        message: api.translate('Some {{ext}} files are not valid for this game.',
          { replace: { ext: gameData.type } }),
        actions: [
          {
            title: 'More',
            action: () => showMultiErrorDetailsDialog(api, issues, gameData),
          },
        ],
      });
    } else {
      log('debug', 'No issues with BA2/BSA files. Total checked:', archivesToCheck.length);
    }

  } catch (err) {
    log('error', 'Error checking for BSA errors', err);
    return;
  }

}

function showMultiErrorDetailsDialog(api: types.IExtensionApi, issues, gameData) {
  const t = api.translate;
  const thisGame = gameData.gameName;
  const groupedErrors = {noMod: []};
  issues.map((cur) => {
    if (cur.mod) {
      if (!groupedErrors[cur.mod.id]) {
        groupedErrors[cur.mod.id] = [];
      }
      groupedErrors[cur.mod.id].push(cur);
    } else {
      groupedErrors.noMod.push(cur);
    }
  }, {});

  const errorsByMod = Object.keys(groupedErrors).map(key => {
    const group = groupedErrors[key];
    const mod = key !== 'noMod' ? group[0].mod : {id: '', attributes: {}};
    const attr = mod.attributes;
    const modName = attr.customName || attr.logicalFileName || attr.name || mod.id;

    if (!group.length) {
      return '';
    }
    const archiveErrors = group.map(a => {
      const games = archiveData.filter(g => g.version === a.version)
                               .map(g => g.gameName).join('/') || t('an unknown game');

      const plugin = a.plugin.name;
      return `[*][b]${a.name}[/b] - ${t('Is loaded by {{plugin}}, but is intended for use in {{games}}.', { replace: { plugin, games } })}`;
    });

    return `[h3]${t('Incompatible Archives')} ${modName ? `: ${modName}` : t('not managed by Vortex')}[/h3]`
    + `[list]${archiveErrors.join()}[/list]<br/><br/>`;

  });

  api.showDialog(
    'error',
    'Incompatible mod archives',
    {
      bbcode:
        `${t('Some of the {{ext}} archives in your load order are incompatible with {{thisGame}}. Using incompatible archives may cause your game to crash on load. ',
        { replace: { thisGame } })}
        ${errorsByMod.join()}
        ${t('You can fix this problem yourself by removing any mods that are not intended to be used with {{thisGame}}. ' +
        'If you downloaded these mods from the correct game site at Nexus Mods, you should inform the mod author of this issue. ' +
        'Archives for this game must be {{ext}} files (v{{ver}}).',
        { replace: { thisGame, ext: gameData.type, ver: gameData.version } })}`,
    },
    [{
      label: 'OK',
      action: () => null,
    }],
  );
}

async function streamArchiveVersion(filePath: string): Promise<any> {
  // Open a stream to the first 9 bytes of the file.
  const stream = fs.createReadStream(filePath, {start: 0, end: 8});

  return new Promise((resolve, reject) => {
    // Create a buffer to house those bytes.
    const data = Buffer.alloc(9);
    stream.on('data', chunk => {
      // Fill the buffer.
      data.fill(chunk);
      // Resolve to the archive version number.
      const versionBytes = data.slice(4, 8);
      const version = versionBytes.reduce((accum, entry) => accum += entry, 0);
      resolve(version);
    });

    stream.on('error', () => resolve(0));
  })
  // Destroy the file stream.
  .finally(() => stream.destroy());
}

export default main;
