import ts from 'typescript';

export class NoDefaultExportError extends Error {
  // no-op
}

export namespace PluginTranspiler {
  export interface IOptions {
    compilerOptions: ts.CompilerOptions & { target: ts.ScriptTarget };
  }
  /**
   * Representation of a single imported value.
   */
  export interface IImportStatement {
    name: string;
    alias?: string;
    module: string;
    unpack: boolean;
    isTypeOnly: boolean;
    isDefault?: boolean;
  }
}

export class PluginTranspiler {
  private _options: PluginTranspiler.IOptions;
  readonly importFunctionName = 'require';

  constructor(options: PluginTranspiler.IOptions) {
    this._options = options;
  }

  /**
   * Transpile an ES6 plugin into a function body of an async function,
   * returning the plugin that would be exported as default.
   */
  transpile(code: string, requireDefaultExport: boolean): string {
    const result = ts.transpileModule(code, {
      compilerOptions: {
        ...this._options.compilerOptions,
        module: ts.ModuleKind.CommonJS
      },
      transformers: {
        before: [this._exportTransformer(requireDefaultExport)]
      }
    });
    const body = result.outputText.replace(/ require\(/g, ' await require(');
    return `'use strict';\nconst exports = {};\n${body}\nreturn exports;`;
  }

  private _exportTransformer(
    requireDefaultExport: boolean
  ): ts.TransformerFactory<ts.SourceFile> {
    return context => {
      let defaultExport: ts.Expression | null = null;

      const visit: ts.Visitor = node => {
        // default export
        if (ts.isExportAssignment(node)) {
          const hasDefaultClause = node
            .getChildren()
            .some(node => node.kind === ts.SyntaxKind.DefaultKeyword);
          if (hasDefaultClause) {
            defaultExport = node.expression;
          } else {
            console.warn(
              'Export assignment without default keyword not supported: ' +
                node.getText(),
              node
            );
          }
        }
        return ts.visitEachChild(node, child => visit(child), context);
      };
      return source => {
        const withoutExports = ts.visitNode(source, visit);
        if (!defaultExport && requireDefaultExport) {
          throw new NoDefaultExportError('No default export found');
        }
        return withoutExports;
      };
    };
  }
}
