import { Dialog, showDialog } from '@jupyterlab/apputils';

import { formatImportError } from './errors';

import { Token } from '@lumino/coreutils';

import { PathExt } from '@jupyterlab/coreutils';

import { IRequireJS } from './requirejs';

import { IModule } from './types';

import { IDocumentManager } from '@jupyterlab/docmanager';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { formatCDNConsentDialog } from './dialogs';

function handleImportError(error: Error, data: string) {
  return showDialog({
    title: `Import in plugin code failed: ${error.message}`,
    body: formatImportError(error, data)
  });
}

export namespace ImportResolver {
  export interface IOptions {
    modules: Record<string, IModule>;
    tokenMap: Map<string, Token<any>>;
    requirejs: IRequireJS;
    settings: ISettingRegistry.ISettings;
    documentManager: IDocumentManager | null;
    /**
     * Path of the module to load, used to resolve relative imports.
     */
    basePath: string | null;
  }
}

type CDNPolicy = 'awaiting-decision' | 'always-insecure' | 'never';

async function askUserForCDNPolicy(
  exampleModule: string,
  cdnUrl: string
): Promise<CDNPolicy | 'abort-to-investigate'> {
  const decision = await showDialog({
    title: 'Allow execution of code from CDN?',
    body: formatCDNConsentDialog(exampleModule, cdnUrl),
    buttons: [
      Dialog.okButton({
        label: 'Forbid'
      }),
      Dialog.cancelButton({
        label: 'Abort'
      }),
      Dialog.warnButton({
        label: 'Allow'
      })
    ],
    defaultButton: 0
  });
  switch (decision.button.label) {
    case 'Forbid':
      return 'never';
    case 'Allow':
      return 'always-insecure';
    case 'Abort':
      return 'abort-to-investigate';
    default:
      return 'awaiting-decision';
  }
}

interface ICDNConsent {
  readonly agreed: boolean;
}

export class ImportResolver {
  constructor(private _options: ImportResolver.IOptions) {
    // no-op
  }

  /**
   * Convert import to:
   *   - token string,
   *   - module assignment if appropriate module is available,
   *   - requirejs import if everything else fails
   */
  async resolve(moduleName: string): Promise<IModule> {
    try {
      const tokenHandler = {
        get: (
          target: IModule,
          prop: string | number | symbol,
          receiver: any
        ) => {
          if (typeof prop !== 'string') {
            return Reflect.get(target, prop, receiver);
          }
          const tokenName = `${moduleName}:${prop}`;
          if (this._options.tokenMap.has(tokenName)) {
            // eslint-disable-next-line  @typescript-eslint/no-non-null-assertion
            return this._options.tokenMap.get(tokenName)!;
          }
          return Reflect.get(target, prop, receiver);
        }
      };

      const knownModule = this._resolveKnownModule(moduleName);
      if (knownModule !== null) {
        return new Proxy(knownModule, tokenHandler);
      }
      const localFile = await this._resolveLocalFile(moduleName);
      if (localFile !== null) {
        return localFile;
      }

      const baseURL = this._options.settings.composite.requirejsCDN as string;
      const consent = await this._getCDNConsent(moduleName, baseURL);

      if (!consent.agreed) {
        throw new Error(
          `Module ${moduleName} requires execution from CDN but it is not allowed.`
        );
      }

      const externalAMDModule = await this._resolveAMDModule(moduleName);
      if (externalAMDModule !== null) {
        return externalAMDModule;
      }
      throw new Error(`Could not resolve the module ${moduleName}`);
    } catch (error) {
      handleImportError(error as Error, moduleName);
      throw error;
    }
  }

  private async _getCDNConsent(
    data: string,
    cdnUrl: string
  ): Promise<ICDNConsent> {
    const allowCDN = this._options.settings.composite.allowCDN as CDNPolicy;
    switch (allowCDN) {
      case 'awaiting-decision': {
        const newPolicy = await askUserForCDNPolicy(data, cdnUrl);
        if (newPolicy === 'abort-to-investigate') {
          throw new Error('User aborted execution when asked about CDN policy');
        } else {
          await this._options.settings.set('allowCDN', newPolicy);
        }
        return await this._getCDNConsent(data, cdnUrl);
      }
      case 'never':
        console.warn(
          'Not loading the module ',
          data,
          'as it is not a known token/module and the CDN policy is set to `never`'
        );
        return { agreed: false };
      case 'always-insecure':
        return { agreed: true };
    }
  }

  private _resolveKnownModule(data: string): IModule | null {
    if (Object.prototype.hasOwnProperty.call(this._options.modules, data)) {
      return this._options.modules[data];
    }
    return null;
  }

  private async _resolveAMDModule(data: string): Promise<IModule | null> {
    const require = this._options.requirejs.require;
    return new Promise((resolve, reject) => {
      require([data], (mod: IModule) => {
        return resolve(mod);
      }, (error: Error) => {
        return reject(error);
      });
    });
  }

  private async _resolveLocalFile(data: string): Promise<IModule | null> {
    if (!data.startsWith('.')) {
      // not a local file, can't help here
      return null;
    }
    const documentManager = this._options.documentManager;
    if (documentManager === null) {
      throw Error(
        `Cannot resolve import of local module ${data}: document manager is not available`
      );
    }
    const path = this._options.basePath;
    if (path === null) {
      throw Error(
        `Cannot resolve import of local module ${data}: the base path was not provided`
      );
    }
    const file = await documentManager.services.contents.get(
      PathExt.join(PathExt.dirname(path), data + '.ts')
    );
    // TODO
    return file.content;
  }
}
