#!/usr/bin/env node
// load static module: ${__dirname }/static_modules.fs
require('../static-loader.js').load(`${__dirname}/../static_modules.fs`)

// Ensure that if we're running in an electron process, that things will work as if it were node.
process.env['ELECTRON_RUN_AS_NODE'] = "1";
delete process.env['ELECTRON_NO_ATTACH_CONSOLE'];

import { AutoRest } from "../lib/autorest-core";
import { Message, Channel } from "../lib/message"
import { JsonPath, SourceMap } from './source-map';
import { IFileSystem } from "../lib/file-system";
import { Artifact } from "../lib/artifact";
import { ResolveUri, FileUriToPath, GetExtension, IsUri } from '../lib/ref/uri';
import { From } from "linq-es2015";
import { safeDump } from "js-yaml";
import { DocumentAnalysis } from "./document-analysis";
import { isFile, writeFile, isDirectory, readdir, readFile } from "@microsoft.azure/async-io"
import { createHash } from 'crypto';
import { Configuration } from "../lib/configuration"

import {
  IConnection,
  TextDocuments, DiagnosticSeverity, InitializedParams, TextDocument,
  InitializeParams, TextDocumentPositionParams, DidChangeConfigurationParams,
  Range, Position, DidChangeWatchedFilesParams, TextDocumentChangeEvent, Hover, Location,
  MarkedString, FileEvent, Diagnostic, createConnection,
  InitializeResult, DidChangeConfigurationNotification, Proposed, ProposedFeatures,
  TextDocumentSyncKind, IPCMessageReader, IPCMessageWriter
} from 'vscode-languageserver';



//TODO: adding URL here temporarily, this should be coming either in the message coming from autorest or the plugin
const azureValidatorRulesDocUrl = "https://github.com/Azure/azure-rest-api-specs/blob/current/documentation/openapi-authoring-automated-guidelines.md";

const md5 = (content: any) => content ? createHash('md5').update(JSON.stringify(content)).digest("hex") : null;

class Result {
  private readonly onDispose = new Array<() => void>();
  private files = new Array<string>();
  private busy: Promise<void> = Promise.resolve();

  public readonly artifacts: Array<Artifact> = new Array<Artifact>();
  private readonly AutoRest: AutoRest;
  private static active = 0;

  private dispose() {
    for (const each of this.onDispose) {
      each();
    }
  }
  public cancel: () => Promise<void> = async () => { };
  public ready = () => { };

  constructor(private readonly service: OpenApiLanugageService, configurationUrl: string) {
    this.AutoRest = new AutoRest(service, configurationUrl);

    this.onDispose.push(this.AutoRest.GeneratedFile.Subscribe((a, artifact) => this.artifacts.push(artifact)));
    this.onDispose.push(this.AutoRest.Message.Subscribe((au, message) => {
      switch (message.Channel) {
        case Channel.Debug:
          service.debug(message.Text);
          break;
        case Channel.Fatal:
          service.error(message.Text);
          break;
        case Channel.Verbose:
          service.verbose(message.Text);
          break;
        case Channel.Information:
          service.log(message.Text);
          break;

        case Channel.Warning:
          service.pushDiagnostic(message, DiagnosticSeverity.Warning);
          break;
        case Channel.Error:
          service.pushDiagnostic(message, DiagnosticSeverity.Error);
          break;
        case Channel.Information:
          service.pushDiagnostic(message, DiagnosticSeverity.Information);
          break;
        case Channel.Hint:
          service.pushDiagnostic(message, DiagnosticSeverity.Hint);
          break;
      }
    }));

    this.onDispose.push(this.AutoRest.Finished.Subscribe((a, success) => {
      // anything after it's done?
      service.debug(`Finished Autorest ${success}`);

      // clear diagnostics for next run
      for (const f of this.files) {
        const diagnostics = this.service.getDiagnosticCollection(f);
        // make sure that the last of the last is sent
        diagnostics.send();

        // then clear the collection it since we're sure this is the end of the run.
        diagnostics.clear();
      }
      Result.active--;
      this.updateStatus();
      this.ready();
    }));
  }

  private updateStatus() {
    if (Result.active === 0) {
      this.service.setStatus("idle");
      return;
    }
    this.service.setStatus(`active:${Result.active}`);
  }

  public async process() {
    Result.active++;
    this.updateStatus();

    // make sure we're clear to start
    await this.busy;

    // reset the busy flag
    this.busy = new Promise((r, j) => this.ready = r);

    // ensure that we have nothing left over from before
    this.clear();

    // set configuration
    await this.resetConfiguration(this.service.settings.configuration)

    // get the list of files this is running on
    this.files = (await this.AutoRest.view).InputFileUris;

    // start it up!
    const processResult = this.AutoRest.Process();

    this.cancel = async () => {
      // cancel only once!
      this.cancel = async () => { };

      // cancel the current process if running.
      processResult.cancel();
    };
  }

  public async resetConfiguration(configuration: any) {
    // wipe the previous configuration
    await this.AutoRest.ResetConfiguration();

    // set the basic defaults we need
    this.AutoRest.AddConfiguration({
      "output-artifact": ["swagger-document.json", "swagger-document.json.map"]
      // debug and verbose messages are not sent by default, turn them on so client settings can decide to show or not.
      , debug: true,
      verbose: true
    });

    // apply settings from the client
    if (configuration) {
      this.AutoRest.AddConfiguration(configuration);
    }
  }

  public clear() {
    this.artifacts.length = 0;
  }
}

class Diagnostics {
  // map allows us to hash the diagnostics to filter out duplicates.
  private diagnostics = new Map<string, Diagnostic>();

  public constructor(private connection: IConnection, private fileUri: string) {
  }

  public clear(send: boolean = false) {
    this.diagnostics.clear();
    if (send) {
      this.send();
    }
  }

  public send() {
    this.connection.sendDiagnostics({ uri: this.fileUri, diagnostics: [...this.diagnostics.values()] });
  }

  public push(diagnostic: Diagnostic, send: boolean = true) {
    const hash = md5(diagnostic) || "";
    if (!this.diagnostics.has(hash)) {
      this.diagnostics.set(hash, diagnostic);
      if (send) {
        this.send();
      }
    }
  }
}


export interface generated {
  messages: Array<string>;
  files: Map<string, string>;
}

export class OpenApiLanugageService extends TextDocuments implements IFileSystem {
  private results = new Map</*configfile*/string, Result>();
  private diagnostics = new Map</*file*/string, Diagnostics>();
  private virtualFile = new Map<string, TextDocument>();
  public settings: any = {};

  public get(uri: string): TextDocument {
    const content = super.get(uri);
    if (!content) {
      const name = decodeURIComponent(uri);
      for (const each of super.all()) {
        if (decodeURIComponent(each.uri) === name) {
          return each;
        }
      }
    }
    return content;
  }

  constructor(private connection: IConnection) {
    super();

    //  track opened, changed, saved, and closed files
    this.onDidOpen((p) => this.onDocumentChanged(p.document));
    this.onDidChangeContent((p) => this.onDocumentChanged(p.document));
    this.onDidClose((p) => this.getDiagnosticCollection(p.document.uri).clear(true));
    this.onDidSave((p) => this.onSaving(p.document));

    // subscribe to client settings changes
    connection.onDidChangeConfiguration(config => config.settings && config.settings.autorest ? this.onSettingsChanged(config.settings.autorest) : null)

    // we also get change notifications of files on disk:
    connection.onDidChangeWatchedFiles((changes) => this.onFileEvents(changes.changes));

    // requests for hover/definitions
    connection.onHover((position, _cancel) => this.onHover(position));
    connection.onDefinition((position, _cancel) => this.onDefinition(position));

    connection.onInitialize(params => this.onInitialize(params));

    // connection.onRequest("generate", generateArgs => onGenerate(generateArgs))
    this.setStatus("Starting Up.");

    // expose the features that we want to give to the client
    connection.onRequest("generate", (p) => this.generate(p.documentUri, p.language, p.configuration));
    connection.onRequest("isOpenApiDocument", (p) => this.isOpenApiDocument(p.contentOrUri));
    connection.onRequest("isConfigurationFile", (p) => this.isConfigurationFile(p.contentOrUri));
    connection.onRequest("isSupportedFile", (p) => this.isSupportedFile(p.languageId, p.contentOrUri));
    connection.onRequest("toJSON", (p) => this.toJSON(p.contentOrUri));
    connection.onRequest("findConfigurationFile", p => this.findConfigurationFile(p.documentUri));


    this.listen(connection);
  }

  public async generate(documentUri: string, language: string, configuration: any): Promise<generated> {
    const cfgFile = await this.getConfiguration(documentUri);
    const autorest = new AutoRest(this, cfgFile);
    const cfg: any = {};
    cfg[language] = {
      "output-folder": "/generated"
    };
    autorest.AddConfiguration(cfg);
    autorest.AddConfiguration(configuration);

    const result = {
      files: <any>{},
      messages: new Array<string>()
    };
    autorest.GeneratedFile.Subscribe((a, artifact) => result.files[artifact.uri] = artifact.content);
    autorest.Message.Subscribe((a, message) => result.messages.push(JSON.stringify(message, null, 2)));
    autorest.Finished.Subscribe((a, success) => { });
    const done = autorest.Process();
    await done.finish;

    return result;
  }
  public async isOpenApiDocument(contentOrUri: string): Promise<boolean> {
    return IsUri(contentOrUri) ? await AutoRest.IsSwaggerFile(await this.ReadFile(contentOrUri)) : await AutoRest.IsSwaggerFile(contentOrUri);
  }
  public async isConfigurationFile(contentOrUri: string): Promise<boolean> {
    return IsUri(contentOrUri) ? await AutoRest.IsConfigurationFile(await this.ReadFile(contentOrUri)) : await AutoRest.IsConfigurationFile(contentOrUri);
  }
  public async isSupportedFile(languageId: string, contentOrUri: string): Promise<boolean> {
    if (AutoRest.IsSwaggerExtension(languageId) || AutoRest.IsConfigurationExtension(languageId)) {
      // so far, so good.
      const content = IsUri(contentOrUri) ? await this.ReadFile(contentOrUri) : contentOrUri;
      const isSwag = AutoRest.IsSwaggerFile(content);
      const isConf = AutoRest.IsConfigurationFile(content);
      return await isSwag || await isConf;
    }

    return false;

  }
  public async toJSON(contentOrUri: string): Promise<string> {
    return IsUri(contentOrUri) ? await AutoRest.LiterateToJson(await this.ReadFile(contentOrUri)) : await AutoRest.LiterateToJson(contentOrUri);
  }
  public async findConfigurationFile(documentUri: string): Promise<string> {
    return await AutoRest.DetectConfigurationFile(this, documentUri, true) || "";
  }

  public setStatus(message: string) {
    this.connection.sendNotification("status", message);
  }

  private async onSettingsChanged(serviceSettings: any) {
    // snapshot the current autorest configuration from the client
    const hash = md5(this.settings.configuration);
    this.settings = serviceSettings || {};

    if (hash !== md5(this.settings.configuration)) {
      // if the configuration change involved a change in the autorest configuration
      // we should activate all the open documents again.
      for (const document of this.all()) {
        this.onDocumentChanged(document);
      }
    }
  }

  private async onInitialize(params: InitializeParams): Promise<InitializeResult> {
    await this.onRootUriChanged(params.rootPath || null);

    return {
      capabilities: {
        definitionProvider: true,
        hoverProvider: true,

        // Tell the client that the server works in FULL text document sync mode
        textDocumentSync: TextDocumentSyncKind.Full,
      }
    }
  }

  private async onSaving(document: TextDocument) {

  }

  private async getDocumentAnalysis(documentUri: string): Promise<DocumentAnalysis | null> {
    const config = await this.getConfiguration(documentUri);
    const result = this.results.get(config);
    if (result) {
      await result.ready; // wait for any current process to finish.
      const outputs = result.artifacts;
      const openapiDefinition = From(outputs).Where(x => x.type === "swagger-document.json").Select(x => JSON.parse(x.content)).FirstOrDefault();
      const openapiDefinitionMap = From(outputs).Where(x => x.type === "swagger-document.json.map").Select(x => JSON.parse(x.content)).FirstOrDefault();

      if (openapiDefinition && openapiDefinitionMap) {
        return new DocumentAnalysis(
          documentUri,
          await this.ReadFile(documentUri),
          openapiDefinition,
          new SourceMap(openapiDefinitionMap));
      }
    }
    return null;
  }

  /*@internal*/ public getDiagnosticCollection(fileUri: string): Diagnostics {
    const diag = this.diagnostics.get(fileUri) || new Diagnostics(this.connection, fileUri);
    this.diagnostics.set(fileUri, diag);
    return diag;
  }

  public pushDiagnostic(message: Message, severity: DiagnosticSeverity) {
    let moreInfo = "";
    if (message.Plugin === "azure-validator") {
      if (message.Key) {
        moreInfo = "\n More info: " + azureValidatorRulesDocUrl + "#" + [...message.Key][1].toLowerCase() + "-" + [...message.Key][0].toLowerCase() + "\n";
      }
    }
    if (message.Range) {
      for (const each of message.Range) {
        // get the file reference first


        const file = this.getDiagnosticCollection(each.document);

        if (file) {
          file.push({
            severity: severity,
            range: Range.create(Position.create(each.start.line - 1, each.start.column), Position.create(each.end.line - 1, each.end.column)),
            message: message.Text + moreInfo,
            source: message.Key ? [...message.Key].join("/") : ""
          });
        } else {
          // console.log(each.document)
        }
      }
    }
  }

  private * onHoverRef(docAnalysis: DocumentAnalysis, position: Position): Iterable<MarkedString> {
    const refValueJsonPath = docAnalysis.GetJsonPathFromJsonReferenceAt(position);
    if (refValueJsonPath) {

      for (const location of docAnalysis.GetDefinitionLocations(refValueJsonPath)) {
        yield {
          language: "yaml",
          value: safeDump(location.value)
        };
      }
    } // else {console.log("found nothing that looks like a JSON reference"); return null; }
  }

  private * onHoverJsonPath(docAnalysis: DocumentAnalysis, position: Position): Iterable<MarkedString> {
    const potentialQuery: string = <string>docAnalysis.GetJsonQueryAt(position);
    if (potentialQuery) {

      const queryNodes = [...docAnalysis.GetDefinitionLocations(potentialQuery)];
      yield {
        language: "plaintext",
        value: `${queryNodes.length} matches\n${queryNodes.map(node => node.jsonPath).join("\n")}`
      };
    } // else { console.log("found nothing that looks like a JSON path"); return null; }
  }


  private async onHover(position: TextDocumentPositionParams): Promise<Hover> {
    const docAnalysis = await this.getDocumentAnalysis(position.textDocument.uri);
    return docAnalysis ? <Hover>{
      contents: [
        ...this.onHoverRef(docAnalysis, position.position),
        ...this.onHoverJsonPath(docAnalysis, position.position)
      ]
    } : <Hover><any>null
  }

  private onDefinitionRef(docAnalysis: DocumentAnalysis, position: Position): Iterable<Location> {
    const refValueJsonPath = docAnalysis.GetJsonPathFromJsonReferenceAt(position);
    if (refValueJsonPath) {
      return docAnalysis.GetDocumentLocations(refValueJsonPath);
    } // else  { console.log("found nothing that looks like a JSON reference"); }
    return [];
  }

  private onDefinitionJsonPath(docAnalysis: DocumentAnalysis, position: Position): Iterable<Location> {
    const potentialQuery: string = <string>docAnalysis.GetJsonQueryAt(position);
    if (potentialQuery) {

      return docAnalysis.GetDocumentLocations(potentialQuery);
    } // else  { console.log("found nothing that looks like a JSON path");}
    return [];
  }

  private async onDefinition(position: TextDocumentPositionParams): Promise<Location[]> {
    const docAnalysis = await this.getDocumentAnalysis(position.textDocument.uri);
    return docAnalysis ? [
      ...this.onDefinitionRef(docAnalysis, position.position),
      ...this.onDefinitionJsonPath(docAnalysis, position.position)
    ] : [];
  }

  private async onFileEvents(changes: FileEvent[]) {
    this.debug(`onFileEvents: ${changes}`);
    for (const each of changes) {

      const doc = this.get(each.uri);
      if (doc) {
        this.onDocumentChanged(doc);
        return;
      }

      let documentUri = each.uri;
      const txt = await this.ReadFile(each.uri);
      if (documentUri.startsWith("file://")) {
        // fake out a document for us to play with
        this.onDocumentChanged({
          uri: each.uri,
          languageId: "",
          version: 1,
          getText: () => txt,
          positionAt: (offset: number) => <Position>{},
          offsetAt: (position: Position) => 0,
          lineCount: 1
        });
      }
    }
  }
  // IFileSystem Implementation
  public async EnumerateFileUris(folderUri: string): Promise<Array<string>> {
    if (folderUri && folderUri.startsWith("file:")) {
      const folderPath = FileUriToPath(folderUri);
      if (await isDirectory(folderPath)) {
        const items = await readdir(folderPath);
        return From<string>(items).Where(each => AutoRest.IsConfigurationExtension(GetExtension(each))).Select(each => ResolveUri(folderUri, each)).ToArray();
      }
    }

    return [];
  }

  public async ReadFile(fileUri: string): Promise<string> {
    const doc = this.get(fileUri) || this.virtualFile.get(fileUri);
    try {
      if (doc) {
        return doc.getText();
      }

      const content = await readFile(FileUriToPath(fileUri));

      return content;
    } catch {
    }
    return "";
  }

  private async process(configurationUrl: string) {
    const result = this.results.get(configurationUrl) || new Result(this, configurationUrl);
    this.results.set(configurationUrl, result);

    // ensure that we are no longer processing a previous run.
    await result.cancel();

    // process the files.
    await result.process();
  }

  private async getConfiguration(documentUri: string): Promise<string> {
    // let folder = ResolveUri(documentUri, ".");
    let configFiles = await Configuration.DetectConfigurationFiles(this, documentUri, undefined, true);

    // is the document a config file?
    if (configFiles.length === 1 && configFiles[0] == documentUri) {
      return documentUri;
    }

    // is there a config file that contains the document as an input?
    for (const configFile of configFiles) {
      const a = new AutoRest(this, configFile);
      const inputs = (await a.view).InputFileUris
      for (const input of inputs) {
        if (input === documentUri || decodeURIComponent(input) == decodeURIComponent(documentUri)) {
          return configFile;
        }
      }
    }

    // didn't find a match, let's make a dummy one.
    const configFile = `${documentUri}/readme.md`;
    if (!this.virtualFile.get(configFile)) {
      this.virtualFile.set(configFile, {
        uri: configFile,
        languageId: "markdown",
        version: 1,
        getText: () => "#Fake config file \n> see https://aka.ms/autorest \n``` yaml \ninput-file: \n - " + documentUri,
        positionAt: (offset: number) => <Position>{},
        offsetAt: (position: Position) => 0,
        lineCount: 1
      });
    }

    return configFile;
  }

  private async onDocumentChanged(document: TextDocument) {
    this.debug(`onDocumentChanged: ${document.uri}`);

    if (AutoRest.IsSwaggerExtension(document.languageId) && await AutoRest.IsSwaggerFile(document.getText())) {
      // find the configuration file and activate that.
      this.process(await this.getConfiguration(document.uri));
      return;
    }

    // is this a config file?
    if (AutoRest.IsConfigurationExtension(document.languageId) && await AutoRest.IsConfigurationFile(document.getText())) {
      this.process(document.uri);
      return;
    }

    // neither 
    // clear any results we have for this.
    const result = this.results.get(document.uri);
    if (result) {
      // this used to be a config file
      result.cancel();
      result.clear();
    }

    // let's clear anything we may have sent for this file.
    this.getDiagnosticCollection(document.uri).clear(true);
  }

  public async onRootUriChanged(rootUri: string | null) {
    this.debug(`onRootUriChanged: ${rootUri}`);
    if (rootUri) {
      // check this folder for a configuration file
      const configFile = await Configuration.DetectConfigurationFile(this, rootUri, undefined, false);

      if (configFile) {
        const content = await this.ReadFile(configFile);
        const document = {
          uri: configFile,
          languageId: "markdown",
          version: 1,
          getText: () => content,
          positionAt: (offset: number) => <Position>{},
          offsetAt: (position: Position) => 0,
          lineCount: 1
        };
        this.virtualFile.set(configFile, document);
        this.onDocumentChanged(document);
      }
    }
  }

  public error(text: string) {
    this.connection.console.error(text);
  }
  public debug(text: string) {
    if (this.settings.debug) {
      this.connection.console.info(text);
    }
  }
  public log(text: string) {
    this.connection.console.log(text);
  }
  public verbose(text: string) {
    if (this.settings.verbose) {
      this.connection.console.log(text);
    }
  }
  public verboseDebug(text: string) {
    if (this.settings.verbose && this.settings.debug) {
      this.connection.console.info(text);
    }
  }
}

// Create the IPC Channel for the lanaguage service.
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let languageService = new OpenApiLanugageService(connection);

process.on("unhandledRejection", function (err) {
  // 
  // @Future_Garrett - only turn this on as a desperate move of last resort.
  // You'll be sorry, and you will waste another day going down this rat hole
  // looking for the reason something is failing only to find out that it's only
  // during the detection if a file is swagger or not, and then you'll 
  // realize why I wrote this message. Don't say I didn't warn you. 
  // -- @Past_Garrett
  // 
  // languageService.verboseDebug(`Unhandled Rejection Suppressed: ${err}`);
});


// Listen on the connection
connection.listen();