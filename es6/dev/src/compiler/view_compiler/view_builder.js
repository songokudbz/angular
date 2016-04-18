import { isPresent, StringWrapper } from 'angular2/src/facade/lang';
import { ListWrapper, StringMapWrapper, SetWrapper } from 'angular2/src/facade/collection';
import * as o from '../output/output_ast';
import { Identifiers, identifierToken } from '../identifiers';
import { ViewConstructorVars, InjectMethodVars, DetectChangesVars, ViewTypeEnum, ViewEncapsulationEnum, ChangeDetectionStrategyEnum, ViewProperties } from './constants';
import { ChangeDetectionStrategy, isDefaultChangeDetectionStrategy } from 'angular2/src/core/change_detection/change_detection';
import { CompileView } from './compile_view';
import { CompileElement, CompileNode } from './compile_element';
import { templateVisitAll } from '../template_ast';
import { getViewFactoryName, createFlatArray, createDiTokenExpression } from './util';
import { ViewType } from 'angular2/src/core/linker/view_type';
import { ViewEncapsulation } from 'angular2/src/core/metadata/view';
import { HOST_VIEW_ELEMENT_NAME } from 'angular2/src/core/linker/view';
import { CompileIdentifierMetadata } from '../compile_metadata';
import { bindView } from './view_binder';
const IMPLICIT_TEMPLATE_VAR = '\$implicit';
const CLASS_ATTR = 'class';
const STYLE_ATTR = 'style';
var parentRenderNodeVar = o.variable('parentRenderNode');
var rootSelectorVar = o.variable('rootSelector');
export class ViewCompileDependency {
    constructor(comp, factoryPlaceholder) {
        this.comp = comp;
        this.factoryPlaceholder = factoryPlaceholder;
    }
}
export function buildView(view, template, targetDependencies, targetStatements) {
    var builderVisitor = new ViewBuilderVisitor(view, targetDependencies, targetStatements);
    templateVisitAll(builderVisitor, template, view.declarationElement.isNull() ?
        view.declarationElement :
        view.declarationElement.parent);
    // Need to separate binding from creation to be able to refer to
    // variables that have been declared after usage.
    bindView(view, template);
    view.afterNodes();
    createViewTopLevelStmts(view, targetStatements);
    return builderVisitor.nestedViewCount;
}
class ViewBuilderVisitor {
    constructor(view, targetDependencies, targetStatements) {
        this.view = view;
        this.targetDependencies = targetDependencies;
        this.targetStatements = targetStatements;
        this.nestedViewCount = 0;
    }
    _isRootNode(parent) { return parent.view !== this.view; }
    _addRootNodeAndProject(node, ngContentIndex, parent) {
        var appEl = node instanceof CompileElement ? node.getOptionalAppElement() : null;
        if (this._isRootNode(parent)) {
            // store root nodes only for embedded/host views
            if (this.view.viewType !== ViewType.COMPONENT) {
                this.view.rootNodesOrAppElements.push(isPresent(appEl) ? appEl : node.renderNode);
            }
        }
        else if (isPresent(parent.component) && isPresent(ngContentIndex)) {
            parent.addContentNode(ngContentIndex, isPresent(appEl) ? appEl : node.renderNode);
        }
    }
    _getParentRenderNode(parent) {
        if (this._isRootNode(parent)) {
            if (this.view.viewType === ViewType.COMPONENT) {
                return parentRenderNodeVar;
            }
            else {
                // root node of an embedded/host view
                return o.NULL_EXPR;
            }
        }
        else {
            return isPresent(parent.component) &&
                parent.component.template.encapsulation !== ViewEncapsulation.Native ?
                o.NULL_EXPR :
                parent.renderNode;
        }
    }
    visitBoundText(ast, parent) {
        return this._visitText(ast, '', ast.ngContentIndex, parent);
    }
    visitText(ast, parent) {
        return this._visitText(ast, ast.value, ast.ngContentIndex, parent);
    }
    _visitText(ast, value, ngContentIndex, parent) {
        var fieldName = `_text_${this.view.nodes.length}`;
        this.view.fields.push(new o.ClassField(fieldName, o.importType(this.view.genConfig.renderTypes.renderText), [o.StmtModifier.Private]));
        var renderNode = o.THIS_EXPR.prop(fieldName);
        var compileNode = new CompileNode(parent, this.view, this.view.nodes.length, renderNode, ast);
        var createRenderNode = o.THIS_EXPR.prop(fieldName)
            .set(ViewProperties.renderer.callMethod('createText', [
            this._getParentRenderNode(parent),
            o.literal(value),
            this.view.createMethod.resetDebugInfoExpr(this.view.nodes.length, ast)
        ]))
            .toStmt();
        this.view.nodes.push(compileNode);
        this.view.createMethod.addStmt(createRenderNode);
        this._addRootNodeAndProject(compileNode, ngContentIndex, parent);
        return renderNode;
    }
    visitNgContent(ast, parent) {
        // the projected nodes originate from a different view, so we don't
        // have debug information for them...
        this.view.createMethod.resetDebugInfo(null, ast);
        var parentRenderNode = this._getParentRenderNode(parent);
        var nodesExpression = ViewProperties.projectableNodes.key(o.literal(ast.index), new o.ArrayType(o.importType(this.view.genConfig.renderTypes.renderNode)));
        if (parentRenderNode !== o.NULL_EXPR) {
            this.view.createMethod.addStmt(ViewProperties.renderer.callMethod('projectNodes', [
                parentRenderNode,
                o.importExpr(Identifiers.flattenNestedViewRenderNodes)
                    .callFn([nodesExpression])
            ])
                .toStmt());
        }
        else if (this._isRootNode(parent)) {
            if (this.view.viewType !== ViewType.COMPONENT) {
                // store root nodes only for embedded/host views
                this.view.rootNodesOrAppElements.push(nodesExpression);
            }
        }
        else {
            if (isPresent(parent.component) && isPresent(ast.ngContentIndex)) {
                parent.addContentNode(ast.ngContentIndex, nodesExpression);
            }
        }
        return null;
    }
    visitElement(ast, parent) {
        var nodeIndex = this.view.nodes.length;
        var createRenderNodeExpr;
        var debugContextExpr = this.view.createMethod.resetDebugInfoExpr(nodeIndex, ast);
        var createElementExpr = ViewProperties.renderer.callMethod('createElement', [this._getParentRenderNode(parent), o.literal(ast.name), debugContextExpr]);
        if (nodeIndex === 0 && this.view.viewType === ViewType.HOST) {
            createRenderNodeExpr =
                rootSelectorVar.identical(o.NULL_EXPR)
                    .conditional(createElementExpr, ViewProperties.renderer.callMethod('selectRootElement', [rootSelectorVar, debugContextExpr]));
        }
        else {
            createRenderNodeExpr = createElementExpr;
        }
        var fieldName = `_el_${nodeIndex}`;
        this.view.fields.push(new o.ClassField(fieldName, o.importType(this.view.genConfig.renderTypes.renderElement), [o.StmtModifier.Private]));
        var createRenderNode = o.THIS_EXPR.prop(fieldName).set(createRenderNodeExpr).toStmt();
        var renderNode = o.THIS_EXPR.prop(fieldName);
        var component = ast.getComponent();
        var directives = ast.directives.map(directiveAst => directiveAst.directive);
        var variables = _readHtmlAndDirectiveVariables(ast.exportAsVars, ast.directives, this.view.viewType);
        this.view.createMethod.addStmt(createRenderNode);
        var htmlAttrs = _readHtmlAttrs(ast.attrs);
        var attrNameAndValues = _mergeHtmlAndDirectiveAttrs(htmlAttrs, directives);
        for (var i = 0; i < attrNameAndValues.length; i++) {
            var attrName = attrNameAndValues[i][0];
            var attrValue = attrNameAndValues[i][1];
            this.view.createMethod.addStmt(ViewProperties.renderer.callMethod('setElementAttribute', [renderNode, o.literal(attrName), o.literal(attrValue)])
                .toStmt());
        }
        var compileElement = new CompileElement(parent, this.view, nodeIndex, renderNode, ast, directives, ast.providers, variables);
        this.view.nodes.push(compileElement);
        var compViewExpr = null;
        if (isPresent(component)) {
            var nestedComponentIdentifier = new CompileIdentifierMetadata({ name: getViewFactoryName(component, 0) });
            this.targetDependencies.push(new ViewCompileDependency(component, nestedComponentIdentifier));
            compViewExpr = o.variable(`compView_${nodeIndex}`);
            this.view.createMethod.addStmt(compViewExpr.set(o.importExpr(nestedComponentIdentifier)
                .callFn([
                ViewProperties.viewManager,
                compileElement.getOrCreateInjector(),
                compileElement.getOrCreateAppElement()
            ]))
                .toDeclStmt());
            compileElement.setComponent(component, compViewExpr);
        }
        compileElement.beforeChildren();
        this._addRootNodeAndProject(compileElement, ast.ngContentIndex, parent);
        templateVisitAll(this, ast.children, compileElement);
        compileElement.afterChildren(this.view.nodes.length - nodeIndex - 1);
        if (isPresent(compViewExpr)) {
            var codeGenContentNodes;
            if (this.view.component.type.isHost) {
                codeGenContentNodes = ViewProperties.projectableNodes;
            }
            else {
                codeGenContentNodes = o.literalArr(compileElement.contentNodesByNgContentIndex.map(nodes => createFlatArray(nodes)));
            }
            this.view.createMethod.addStmt(compViewExpr.callMethod('create', [codeGenContentNodes, o.NULL_EXPR]).toStmt());
        }
        return null;
    }
    visitEmbeddedTemplate(ast, parent) {
        var nodeIndex = this.view.nodes.length;
        var fieldName = `_anchor_${nodeIndex}`;
        this.view.fields.push(new o.ClassField(fieldName, o.importType(this.view.genConfig.renderTypes.renderComment), [o.StmtModifier.Private]));
        var createRenderNode = o.THIS_EXPR.prop(fieldName)
            .set(ViewProperties.renderer.callMethod('createTemplateAnchor', [
            this._getParentRenderNode(parent),
            this.view.createMethod.resetDebugInfoExpr(nodeIndex, ast)
        ]))
            .toStmt();
        var renderNode = o.THIS_EXPR.prop(fieldName);
        var templateVariableBindings = ast.vars.map(varAst => [varAst.value.length > 0 ? varAst.value : IMPLICIT_TEMPLATE_VAR, varAst.name]);
        var directives = ast.directives.map(directiveAst => directiveAst.directive);
        var compileElement = new CompileElement(parent, this.view, nodeIndex, renderNode, ast, directives, ast.providers, {});
        this.view.nodes.push(compileElement);
        this.view.createMethod.addStmt(createRenderNode);
        this.nestedViewCount++;
        var embeddedView = new CompileView(this.view.component, this.view.genConfig, this.view.pipeMetas, o.NULL_EXPR, this.view.viewIndex + this.nestedViewCount, compileElement, templateVariableBindings);
        this.nestedViewCount +=
            buildView(embeddedView, ast.children, this.targetDependencies, this.targetStatements);
        compileElement.beforeChildren();
        this._addRootNodeAndProject(compileElement, ast.ngContentIndex, parent);
        compileElement.afterChildren(0);
        return null;
    }
    visitAttr(ast, ctx) { return null; }
    visitDirective(ast, ctx) { return null; }
    visitEvent(ast, eventTargetAndNames) {
        return null;
    }
    visitVariable(ast, ctx) { return null; }
    visitDirectiveProperty(ast, context) { return null; }
    visitElementProperty(ast, context) { return null; }
}
function _mergeHtmlAndDirectiveAttrs(declaredHtmlAttrs, directives) {
    var result = {};
    StringMapWrapper.forEach(declaredHtmlAttrs, (value, key) => { result[key] = value; });
    directives.forEach(directiveMeta => {
        StringMapWrapper.forEach(directiveMeta.hostAttributes, (value, name) => {
            var prevValue = result[name];
            result[name] = isPresent(prevValue) ? mergeAttributeValue(name, prevValue, value) : value;
        });
    });
    return mapToKeyValueArray(result);
}
function _readHtmlAttrs(attrs) {
    var htmlAttrs = {};
    attrs.forEach((ast) => { htmlAttrs[ast.name] = ast.value; });
    return htmlAttrs;
}
function _readHtmlAndDirectiveVariables(elementExportAsVars, directives, viewType) {
    var variables = {};
    var component = null;
    directives.forEach((directive) => {
        if (directive.directive.isComponent) {
            component = directive.directive;
        }
        directive.exportAsVars.forEach(varAst => { variables[varAst.name] = identifierToken(directive.directive.type); });
    });
    elementExportAsVars.forEach((varAst) => {
        variables[varAst.name] = isPresent(component) ? identifierToken(component.type) : null;
    });
    if (viewType === ViewType.HOST) {
        variables[HOST_VIEW_ELEMENT_NAME] = null;
    }
    return variables;
}
function mergeAttributeValue(attrName, attrValue1, attrValue2) {
    if (attrName == CLASS_ATTR || attrName == STYLE_ATTR) {
        return `${attrValue1} ${attrValue2}`;
    }
    else {
        return attrValue2;
    }
}
function mapToKeyValueArray(data) {
    var entryArray = [];
    StringMapWrapper.forEach(data, (value, name) => { entryArray.push([name, value]); });
    // We need to sort to get a defined output order
    // for tests and for caching generated artifacts...
    ListWrapper.sort(entryArray, (entry1, entry2) => StringWrapper.compare(entry1[0], entry2[0]));
    var keyValueArray = [];
    entryArray.forEach((entry) => { keyValueArray.push([entry[0], entry[1]]); });
    return keyValueArray;
}
function createViewTopLevelStmts(view, targetStatements) {
    var nodeDebugInfosVar = o.NULL_EXPR;
    if (view.genConfig.genDebugInfo) {
        nodeDebugInfosVar = o.variable(`nodeDebugInfos_${view.component.type.name}${view.viewIndex}`);
        targetStatements.push(nodeDebugInfosVar
            .set(o.literalArr(view.nodes.map(createStaticNodeDebugInfo), new o.ArrayType(new o.ExternalType(Identifiers.StaticNodeDebugInfo), [o.TypeModifier.Const])))
            .toDeclStmt(null, [o.StmtModifier.Final]));
    }
    var renderCompTypeVar = o.variable(`renderType_${view.component.type.name}`);
    if (view.viewIndex === 0) {
        targetStatements.push(renderCompTypeVar.set(o.NULL_EXPR)
            .toDeclStmt(o.importType(Identifiers.RenderComponentType)));
    }
    var viewClass = createViewClass(view, renderCompTypeVar, nodeDebugInfosVar);
    targetStatements.push(viewClass);
    targetStatements.push(createViewFactory(view, viewClass, renderCompTypeVar));
}
function createStaticNodeDebugInfo(node) {
    var compileElement = node instanceof CompileElement ? node : null;
    var providerTokens = [];
    var componentToken = o.NULL_EXPR;
    var varTokenEntries = [];
    if (isPresent(compileElement)) {
        providerTokens = compileElement.getProviderTokens();
        if (isPresent(compileElement.component)) {
            componentToken = createDiTokenExpression(identifierToken(compileElement.component.type));
        }
        StringMapWrapper.forEach(compileElement.variableTokens, (token, varName) => {
            varTokenEntries.push([varName, isPresent(token) ? createDiTokenExpression(token) : o.NULL_EXPR]);
        });
    }
    return o.importExpr(Identifiers.StaticNodeDebugInfo)
        .instantiate([
        o.literalArr(providerTokens, new o.ArrayType(o.DYNAMIC_TYPE, [o.TypeModifier.Const])),
        componentToken,
        o.literalMap(varTokenEntries, new o.MapType(o.DYNAMIC_TYPE, [o.TypeModifier.Const]))
    ], o.importType(Identifiers.StaticNodeDebugInfo, null, [o.TypeModifier.Const]));
}
function createViewClass(view, renderCompTypeVar, nodeDebugInfosVar) {
    var emptyTemplateVariableBindings = view.templateVariableBindings.map((entry) => [entry[0], o.NULL_EXPR]);
    var viewConstructorArgs = [
        new o.FnParam(ViewConstructorVars.viewManager.name, o.importType(Identifiers.AppViewManager_)),
        new o.FnParam(ViewConstructorVars.parentInjector.name, o.importType(Identifiers.Injector)),
        new o.FnParam(ViewConstructorVars.declarationEl.name, o.importType(Identifiers.AppElement))
    ];
    var viewConstructor = new o.ClassMethod(null, viewConstructorArgs, [
        o.SUPER_EXPR.callFn([
            o.variable(view.className),
            renderCompTypeVar,
            ViewTypeEnum.fromValue(view.viewType),
            o.literalMap(emptyTemplateVariableBindings),
            ViewConstructorVars.viewManager,
            ViewConstructorVars.parentInjector,
            ViewConstructorVars.declarationEl,
            ChangeDetectionStrategyEnum.fromValue(getChangeDetectionMode(view)),
            o.literal(view.literalArrayCount),
            o.literal(view.literalMapCount),
            nodeDebugInfosVar
        ])
            .toStmt()
    ]);
    var viewMethods = [
        new o.ClassMethod('createInternal', [new o.FnParam(rootSelectorVar.name, o.STRING_TYPE)], generateCreateMethod(view)),
        new o.ClassMethod('injectorGetInternal', [
            new o.FnParam(InjectMethodVars.token.name, o.DYNAMIC_TYPE),
            // Note: Can't use o.INT_TYPE here as the method in AppView uses number
            new o.FnParam(InjectMethodVars.requestNodeIndex.name, o.NUMBER_TYPE),
            new o.FnParam(InjectMethodVars.notFoundResult.name, o.DYNAMIC_TYPE)
        ], addReturnValuefNotEmpty(view.injectorGetMethod.finish(), InjectMethodVars.notFoundResult), o.DYNAMIC_TYPE),
        new o.ClassMethod('detectChangesInternal', [new o.FnParam(DetectChangesVars.throwOnChange.name, o.BOOL_TYPE)], generateDetectChangesMethod(view)),
        new o.ClassMethod('dirtyParentQueriesInternal', [], view.dirtyParentQueriesMethod.finish()),
        new o.ClassMethod('destroyInternal', [], view.destroyMethod.finish())
    ].concat(view.eventHandlerMethods);
    var viewClass = new o.ClassStmt(view.className, o.importExpr(Identifiers.AppView, [getContextType(view)]), view.fields, view.getters, viewConstructor, viewMethods.filter((method) => method.body.length > 0));
    return viewClass;
}
function createViewFactory(view, viewClass, renderCompTypeVar) {
    var viewFactoryArgs = [
        new o.FnParam(ViewConstructorVars.viewManager.name, o.importType(Identifiers.AppViewManager_)),
        new o.FnParam(ViewConstructorVars.parentInjector.name, o.importType(Identifiers.Injector)),
        new o.FnParam(ViewConstructorVars.declarationEl.name, o.importType(Identifiers.AppElement))
    ];
    var initRenderCompTypeStmts = [];
    var templateUrlInfo;
    if (view.component.template.templateUrl == view.component.type.moduleUrl) {
        templateUrlInfo =
            `${view.component.type.moduleUrl} class ${view.component.type.name} - inline template`;
    }
    else {
        templateUrlInfo = view.component.template.templateUrl;
    }
    if (view.viewIndex === 0) {
        initRenderCompTypeStmts = [
            new o.IfStmt(renderCompTypeVar.identical(o.NULL_EXPR), [
                renderCompTypeVar.set(ViewConstructorVars.viewManager
                    .callMethod('createRenderComponentType', [
                    o.literal(templateUrlInfo),
                    o.literal(view.component.template.ngContentSelectors.length),
                    ViewEncapsulationEnum.fromValue(view.component.template.encapsulation),
                    view.styles
                ]))
                    .toStmt()
            ])
        ];
    }
    return o.fn(viewFactoryArgs, initRenderCompTypeStmts.concat([
        new o.ReturnStatement(o.variable(viewClass.name)
            .instantiate(viewClass.constructorMethod.params.map((param) => o.variable(param.name))))
    ]), o.importType(Identifiers.AppView, [getContextType(view)]))
        .toDeclStmt(view.viewFactory.name, [o.StmtModifier.Final]);
}
function generateCreateMethod(view) {
    var parentRenderNodeExpr = o.NULL_EXPR;
    var parentRenderNodeStmts = [];
    if (view.viewType === ViewType.COMPONENT) {
        parentRenderNodeExpr = ViewProperties.renderer.callMethod('createViewRoot', [o.THIS_EXPR.prop('declarationAppElement').prop('nativeElement')]);
        parentRenderNodeStmts = [
            parentRenderNodeVar.set(parentRenderNodeExpr)
                .toDeclStmt(o.importType(view.genConfig.renderTypes.renderNode), [o.StmtModifier.Final])
        ];
    }
    return parentRenderNodeStmts.concat(view.createMethod.finish())
        .concat([
        o.THIS_EXPR.callMethod('init', [
            createFlatArray(view.rootNodesOrAppElements),
            o.literalArr(view.nodes.map(node => node.renderNode)),
            o.literalMap(view.namedAppElements),
            o.literalArr(view.disposables),
            o.literalArr(view.subscriptions)
        ])
            .toStmt()
    ]);
}
function generateDetectChangesMethod(view) {
    var stmts = [];
    if (view.detectChangesInInputsMethod.isEmpty() && view.updateContentQueriesMethod.isEmpty() &&
        view.afterContentLifecycleCallbacksMethod.isEmpty() &&
        view.detectChangesHostPropertiesMethod.isEmpty() && view.updateViewQueriesMethod.isEmpty() &&
        view.afterViewLifecycleCallbacksMethod.isEmpty()) {
        return stmts;
    }
    ListWrapper.addAll(stmts, view.detectChangesInInputsMethod.finish());
    stmts.push(o.THIS_EXPR.callMethod('detectContentChildrenChanges', [DetectChangesVars.throwOnChange])
        .toStmt());
    var afterContentStmts = view.updateContentQueriesMethod.finish().concat(view.afterContentLifecycleCallbacksMethod.finish());
    if (afterContentStmts.length > 0) {
        stmts.push(new o.IfStmt(o.not(DetectChangesVars.throwOnChange), afterContentStmts));
    }
    ListWrapper.addAll(stmts, view.detectChangesHostPropertiesMethod.finish());
    stmts.push(o.THIS_EXPR.callMethod('detectViewChildrenChanges', [DetectChangesVars.throwOnChange])
        .toStmt());
    var afterViewStmts = view.updateViewQueriesMethod.finish().concat(view.afterViewLifecycleCallbacksMethod.finish());
    if (afterViewStmts.length > 0) {
        stmts.push(new o.IfStmt(o.not(DetectChangesVars.throwOnChange), afterViewStmts));
    }
    var varStmts = [];
    var readVars = o.findReadVarNames(stmts);
    if (SetWrapper.has(readVars, DetectChangesVars.changed.name)) {
        varStmts.push(DetectChangesVars.changed.set(o.literal(true)).toDeclStmt(o.BOOL_TYPE));
    }
    if (SetWrapper.has(readVars, DetectChangesVars.changes.name)) {
        varStmts.push(DetectChangesVars.changes.set(o.NULL_EXPR)
            .toDeclStmt(new o.MapType(o.importType(Identifiers.SimpleChange))));
    }
    if (SetWrapper.has(readVars, DetectChangesVars.valUnwrapper.name)) {
        varStmts.push(DetectChangesVars.valUnwrapper.set(o.importExpr(Identifiers.ValueUnwrapper).instantiate([]))
            .toDeclStmt(null, [o.StmtModifier.Final]));
    }
    return varStmts.concat(stmts);
}
function addReturnValuefNotEmpty(statements, value) {
    if (statements.length > 0) {
        return statements.concat([new o.ReturnStatement(value)]);
    }
    else {
        return statements;
    }
}
function getContextType(view) {
    var typeMeta = view.component.type;
    return typeMeta.isHost ? o.DYNAMIC_TYPE : o.importType(typeMeta);
}
function getChangeDetectionMode(view) {
    var mode;
    if (view.viewType === ViewType.COMPONENT) {
        mode = isDefaultChangeDetectionStrategy(view.component.changeDetection) ?
            ChangeDetectionStrategy.CheckAlways :
            ChangeDetectionStrategy.CheckOnce;
    }
    else {
        mode = ChangeDetectionStrategy.CheckAlways;
    }
    return mode;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmlld19idWlsZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGlmZmluZ19wbHVnaW5fd3JhcHBlci1vdXRwdXRfcGF0aC1oMU91SGx1Ny50bXAvYW5ndWxhcjIvc3JjL2NvbXBpbGVyL3ZpZXdfY29tcGlsZXIvdmlld19idWlsZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJPQUFPLEVBQUMsU0FBUyxFQUFFLGFBQWEsRUFBQyxNQUFNLDBCQUEwQjtPQUMxRCxFQUFDLFdBQVcsRUFBRSxnQkFBZ0IsRUFBRSxVQUFVLEVBQUMsTUFBTSxnQ0FBZ0M7T0FFakYsS0FBSyxDQUFDLE1BQU0sc0JBQXNCO09BQ2xDLEVBQUMsV0FBVyxFQUFFLGVBQWUsRUFBQyxNQUFNLGdCQUFnQjtPQUNwRCxFQUNMLG1CQUFtQixFQUNuQixnQkFBZ0IsRUFDaEIsaUJBQWlCLEVBQ2pCLFlBQVksRUFDWixxQkFBcUIsRUFDckIsMkJBQTJCLEVBQzNCLGNBQWMsRUFDZixNQUFNLGFBQWE7T0FDYixFQUNMLHVCQUF1QixFQUN2QixnQ0FBZ0MsRUFDakMsTUFBTSxxREFBcUQ7T0FFckQsRUFBQyxXQUFXLEVBQUMsTUFBTSxnQkFBZ0I7T0FDbkMsRUFBQyxjQUFjLEVBQUUsV0FBVyxFQUFDLE1BQU0sbUJBQW1CO09BRXRELEVBY0wsZ0JBQWdCLEVBR2pCLE1BQU0saUJBQWlCO09BRWpCLEVBQUMsa0JBQWtCLEVBQUUsZUFBZSxFQUFFLHVCQUF1QixFQUFDLE1BQU0sUUFBUTtPQUU1RSxFQUFDLFFBQVEsRUFBQyxNQUFNLG9DQUFvQztPQUNwRCxFQUFDLGlCQUFpQixFQUFDLE1BQU0saUNBQWlDO09BQzFELEVBQUMsc0JBQXNCLEVBQUMsTUFBTSwrQkFBK0I7T0FFN0QsRUFDTCx5QkFBeUIsRUFHMUIsTUFBTSxxQkFBcUI7T0FFckIsRUFBQyxRQUFRLEVBQUMsTUFBTSxlQUFlO0FBRXRDLE1BQU0scUJBQXFCLEdBQUcsWUFBWSxDQUFDO0FBQzNDLE1BQU0sVUFBVSxH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QUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLGVBQWUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDM0QsQ0FBQztJQUFDLElBQUksQ0FBQyxDQUFDO1FBQ04sTUFBTSxDQUFDLFVBQVUsQ0FBQztJQUNwQixDQUFDO0FBQ0gsQ0FBQztBQUVELHdCQUF3QixJQUFpQjtJQUN2QyxJQUFJLFFBQVEsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQztJQUNuQyxNQUFNLENBQUMsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsWUFBWSxHQUFHLENBQUMsQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDbkUsQ0FBQztBQUVELGdDQUFnQyxJQUFpQjtJQUMvQyxJQUFJLElBQTZCLENBQUM7SUFDbEMsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsS0FBSyxRQUFRLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQztRQUN6QyxJQUFJLEdBQUcsZ0NBQWdDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxlQUFlLENBQUM7WUFDNUQsdUJBQXVCLENBQUMsV0FBVztZQUNuQyx1QkFBdUIsQ0FBQyxTQUFTLENBQUM7SUFDL0MsQ0FBQztJQUFDLElBQUksQ0FBQyxDQUFDO1FBQ04sSUFBSSxHQUFHLHVCQUF1QixDQUFDLFdBQVcsQ0FBQztJQUM3QyxDQUFDO0lBQ0QsTUFBTSxDQUFDLElBQUksQ0FBQztBQUNkLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge2lzUHJlc2VudCwgU3RyaW5nV3JhcHBlcn0gZnJvbSAnYW5ndWxhcjIvc3JjL2ZhY2FkZS9sYW5nJztcbmltcG9ydCB7TGlzdFdyYXBwZXIsIFN0cmluZ01hcFdyYXBwZXIsIFNldFdyYXBwZXJ9IGZyb20gJ2FuZ3VsYXIyL3NyYy9mYWNhZGUvY29sbGVjdGlvbic7XG5cbmltcG9ydCAqIGFzIG8gZnJvbSAnLi4vb3V0cHV0L291dHB1dF9hc3QnO1xuaW1wb3J0IHtJZGVudGlmaWVycywgaWRlbnRpZmllclRva2VufSBmcm9tICcuLi9pZGVudGlmaWVycyc7XG5pbXBvcnQge1xuICBWaWV3Q29uc3RydWN0b3JWYXJzLFxuICBJbmplY3RNZXRob2RWYXJzLFxuICBEZXRlY3RDaGFuZ2VzVmFycyxcbiAgVmlld1R5cGVFbnVtLFxuICBWaWV3RW5jYXBzdWxhdGlvbkVudW0sXG4gIENoYW5nZURldGVjdGlvblN0cmF0ZWd5RW51bSxcbiAgVmlld1Byb3BlcnRpZXNcbn0gZnJvbSAnLi9jb25zdGFudHMnO1xuaW1wb3J0IHtcbiAgQ2hhbmdlRGV0ZWN0aW9uU3RyYXRlZ3ksXG4gIGlzRGVmYXVsdENoYW5nZURldGVjdGlvblN0cmF0ZWd5XG59IGZyb20gJ2FuZ3VsYXIyL3NyYy9jb3JlL2NoYW5nZV9kZXRlY3Rpb24vY2hhbmdlX2RldGVjdGlvbic7XG5cbmltcG9ydCB7Q29tcGlsZVZpZXd9IGZyb20gJy4vY29tcGlsZV92aWV3JztcbmltcG9ydCB7Q29tcGlsZUVsZW1lbnQsIENvbXBpbGVOb2RlfSBmcm9tICcuL2NvbXBpbGVfZWxlbWVudCc7XG5cbmltcG9ydCB7XG4gIFRlbXBsYXRlQXN0LFxuICBUZW1wbGF0ZUFzdFZpc2l0b3IsXG4gIE5nQ29udGVudEFzdCxcbiAgRW1iZWRkZWRUZW1wbGF0ZUFzdCxcbiAgRWxlbWVudEFzdCxcbiAgVmFyaWFibGVBc3QsXG4gIEJvdW5kRXZlbnRBc3QsXG4gIEJvdW5kRWxlbWVudFByb3BlcnR5QXN0LFxuICBBdHRyQXN0LFxuICBCb3VuZFRleHRBc3QsXG4gIFRleHRBc3QsXG4gIERpcmVjdGl2ZUFzdCxcbiAgQm91bmREaXJlY3RpdmVQcm9wZXJ0eUFzdCxcbiAgdGVtcGxhdGVWaXNpdEFsbCxcbiAgUHJvcGVydHlCaW5kaW5nVHlwZSxcbiAgUHJvdmlkZXJBc3Rcbn0gZnJvbSAnLi4vdGVtcGxhdGVfYXN0JztcblxuaW1wb3J0IHtnZXRWaWV3RmFjdG9yeU5hbWUsIGNyZWF0ZUZsYXRBcnJheSwgY3JlYXRlRGlUb2tlbkV4cHJlc3Npb259IGZyb20gJy4vdXRpbCc7XG5cbmltcG9ydCB7Vmlld1R5cGV9IGZyb20gJ2FuZ3VsYXIyL3NyYy9jb3JlL2xpbmtlci92aWV3X3R5cGUnO1xuaW1wb3J0IHtWaWV3RW5jYXBzdWxhdGlvbn0gZnJvbSAnYW5ndWxhcjIvc3JjL2NvcmUvbWV0YWRhdGEvdmlldyc7XG5pbXBvcnQge0hPU1RfVklFV19FTEVNRU5UX05BTUV9IGZyb20gJ2FuZ3VsYXIyL3NyYy9jb3JlL2xpbmtlci92aWV3JztcblxuaW1wb3J0IHtcbiAgQ29tcGlsZUlkZW50aWZpZXJNZXRhZGF0YSxcbiAgQ29tcGlsZURpcmVjdGl2ZU1ldGFkYXRhLFxuICBDb21waWxlVG9rZW5NZXRhZGF0YVxufSBmcm9tICcuLi9jb21waWxlX21ldGFkYXRhJztcblxuaW1wb3J0IHtiaW5kVmlld30gZnJvbSAnLi92aWV3X2JpbmRlcic7XG5cbmNvbnN0IElNUExJQ0lUX1RFTVBMQVRFX1ZBUiA9ICdcXCRpbXBsaWNpdCc7XG5jb25zdCBDTEFTU19BVFRSID0gJ2NsYXNzJztcbmNvbnN0IFNUWUxFX0FUVFIgPSAnc3R5bGUnO1xuXG52YXIgcGFyZW50UmVuZGVyTm9kZVZhciA9IG8udmFyaWFibGUoJ3BhcmVudFJlbmRlck5vZGUnKTtcbnZhciByb290U2VsZWN0b3JWYXIgPSBvLnZhcmlhYmxlKCdyb290U2VsZWN0b3InKTtcblxuZXhwb3J0IGNsYXNzIFZpZXdDb21waWxlRGVwZW5kZW5jeSB7XG4gIGNvbnN0cnVjdG9yKHB1YmxpYyBjb21wOiBDb21waWxlRGlyZWN0aXZlTWV0YWRhdGEsXG4gICAgICAgICAgICAgIHB1YmxpYyBmYWN0b3J5UGxhY2Vob2xkZXI6IENvbXBpbGVJZGVudGlmaWVyTWV0YWRhdGEpIHt9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFZpZXcodmlldzogQ29tcGlsZVZpZXcsIHRlbXBsYXRlOiBUZW1wbGF0ZUFzdFtdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXREZXBlbmRlbmNpZXM6IFZpZXdDb21waWxlRGVwZW5kZW5jeVtdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRTdGF0ZW1lbnRzOiBvLlN0YXRlbWVudFtdKTogbnVtYmVyIHtcbiAgdmFyIGJ1aWxkZXJWaXNpdG9yID0gbmV3IFZpZXdCdWlsZGVyVmlzaXRvcih2aWV3LCB0YXJnZXREZXBlbmRlbmNpZXMsIHRhcmdldFN0YXRlbWVudHMpO1xuICB0ZW1wbGF0ZVZpc2l0QWxsKGJ1aWxkZXJWaXNpdG9yLCB0ZW1wbGF0ZSwgdmlldy5kZWNsYXJhdGlvbkVsZW1lbnQuaXNOdWxsKCkgP1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZpZXcuZGVjbGFyYXRpb25FbGVtZW50IDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2aWV3LmRlY2xhcmF0aW9uRWxlbWVudC5wYXJlbnQpO1xuICAvLyBOZWVkIHRvIHNlcGFyYXRlIGJpbmRpbmcgZnJvbSBjcmVhdGlvbiB0byBiZSBhYmxlIHRvIHJlZmVyIHRvXG4gIC8vIHZhcmlhYmxlcyB0aGF0IGhhdmUgYmVlbiBkZWNsYXJlZCBhZnRlciB1c2FnZS5cbiAgYmluZFZpZXcodmlldywgdGVtcGxhdGUpO1xuICB2aWV3LmFmdGVyTm9kZXMoKTtcblxuICBjcmVhdGVWaWV3VG9wTGV2ZWxTdG10cyh2aWV3LCB0YXJnZXRTdGF0ZW1lbnRzKTtcblxuICByZXR1cm4gYnVpbGRlclZpc2l0b3IubmVzdGVkVmlld0NvdW50O1xufVxuXG5cbmNsYXNzIFZpZXdCdWlsZGVyVmlzaXRvciBpbXBsZW1lbnRzIFRlbXBsYXRlQXN0VmlzaXRvciB7XG4gIG5lc3RlZFZpZXdDb3VudDogbnVtYmVyID0gMDtcblxuICBjb25zdHJ1Y3RvcihwdWJsaWMgdmlldzogQ29tcGlsZVZpZXcsIHB1YmxpYyB0YXJnZXREZXBlbmRlbmNpZXM6IFZpZXdDb21waWxlRGVwZW5kZW5jeVtdLFxuICAgICAgICAgICAgICBwdWJsaWMgdGFyZ2V0U3RhdGVtZW50czogby5TdGF0ZW1lbnRbXSkge31cblxuICBwcml2YXRlIF9pc1Jvb3ROb2RlKHBhcmVudDogQ29tcGlsZUVsZW1lbnQpOiBib29sZWFuIHsgcmV0dXJuIHBhcmVudC52aWV3ICE9PSB0aGlzLnZpZXc7IH1cblxuICBwcml2YXRlIF9hZGRSb290Tm9kZUFuZFByb2plY3Qobm9kZTogQ29tcGlsZU5vZGUsIG5nQ29udGVudEluZGV4OiBudW1iZXIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJlbnQ6IENvbXBpbGVFbGVtZW50KSB7XG4gICAgdmFyIGFwcEVsID0gbm9kZSBpbnN0YW5jZW9mIENvbXBpbGVFbGVtZW50ID8gbm9kZS5nZXRPcHRpb25hbEFwcEVsZW1lbnQoKSA6IG51bGw7XG4gICAgaWYgKHRoaXMuX2lzUm9vdE5vZGUocGFyZW50KSkge1xuICAgICAgLy8gc3RvcmUgcm9vdCBub2RlcyBvbmx5IGZvciBlbWJlZGRlZC9ob3N0IHZpZXdzXG4gICAgICBpZiAodGhpcy52aWV3LnZpZXdUeXBlICE9PSBWaWV3VHlwZS5DT01QT05FTlQpIHtcbiAgICAgICAgdGhpcy52aWV3LnJvb3ROb2Rlc09yQXBwRWxlbWVudHMucHVzaChpc1ByZXNlbnQoYXBwRWwpID8gYXBwRWwgOiBub2RlLnJlbmRlck5vZGUpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoaXNQcmVzZW50KHBhcmVudC5jb21wb25lbnQpICYmIGlzUHJlc2VudChuZ0NvbnRlbnRJbmRleCkpIHtcbiAgICAgIHBhcmVudC5hZGRDb250ZW50Tm9kZShuZ0NvbnRlbnRJbmRleCwgaXNQcmVzZW50KGFwcEVsKSA/IGFwcEVsIDogbm9kZS5yZW5kZXJOb2RlKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIF9nZXRQYXJlbnRSZW5kZXJOb2RlKHBhcmVudDogQ29tcGlsZUVsZW1lbnQpOiBvLkV4cHJlc3Npb24ge1xuICAgIGlmICh0aGlzLl9pc1Jvb3ROb2RlKHBhcmVudCkpIHtcbiAgICAgIGlmICh0aGlzLnZpZXcudmlld1R5cGUgPT09IFZpZXdUeXBlLkNPTVBPTkVOVCkge1xuICAgICAgICByZXR1cm4gcGFyZW50UmVuZGVyTm9kZVZhcjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIHJvb3Qgbm9kZSBvZiBhbiBlbWJlZGRlZC9ob3N0IHZpZXdcbiAgICAgICAgcmV0dXJuIG8uTlVMTF9FWFBSO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gaXNQcmVzZW50KHBhcmVudC5jb21wb25lbnQpICYmXG4gICAgICAgICAgICAgICAgICAgICBwYXJlbnQuY29tcG9uZW50LnRlbXBsYXRlLmVuY2Fwc3VsYXRpb24gIT09IFZpZXdFbmNhcHN1bGF0aW9uLk5hdGl2ZSA/XG4gICAgICAgICAgICAgICAgIG8uTlVMTF9FWFBSIDpcbiAgICAgICAgICAgICAgICAgcGFyZW50LnJlbmRlck5vZGU7XG4gICAgfVxuICB9XG5cbiAgdmlzaXRCb3VuZFRleHQoYXN0OiBCb3VuZFRleHRBc3QsIHBhcmVudDogQ29tcGlsZUVsZW1lbnQpOiBhbnkge1xuICAgIHJldHVybiB0aGlzLl92aXNpdFRleHQoYXN0LCAnJywgYXN0Lm5nQ29udGVudEluZGV4LCBwYXJlbnQpO1xuICB9XG4gIHZpc2l0VGV4dChhc3Q6IFRleHRBc3QsIHBhcmVudDogQ29tcGlsZUVsZW1lbnQpOiBhbnkge1xuICAgIHJldHVybiB0aGlzLl92aXNpdFRleHQoYXN0LCBhc3QudmFsdWUsIGFzdC5uZ0NvbnRlbnRJbmRleCwgcGFyZW50KTtcbiAgfVxuICBwcml2YXRlIF92aXNpdFRleHQoYXN0OiBUZW1wbGF0ZUFzdCwgdmFsdWU6IHN0cmluZywgbmdDb250ZW50SW5kZXg6IG51bWJlcixcbiAgICAgICAgICAgICAgICAgICAgIHBhcmVudDogQ29tcGlsZUVsZW1lbnQpOiBvLkV4cHJlc3Npb24ge1xuICAgIHZhciBmaWVsZE5hbWUgPSBgX3RleHRfJHt0aGlzLnZpZXcubm9kZXMubGVuZ3RofWA7XG4gICAgdGhpcy52aWV3LmZpZWxkcy5wdXNoKG5ldyBvLkNsYXNzRmllbGQoZmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG8uaW1wb3J0VHlwZSh0aGlzLnZpZXcuZ2VuQ29uZmlnLnJlbmRlclR5cGVzLnJlbmRlclRleHQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFtvLlN0bXRNb2RpZmllci5Qcml2YXRlXSkpO1xuICAgIHZhciByZW5kZXJOb2RlID0gby5USElTX0VYUFIucHJvcChmaWVsZE5hbWUpO1xuICAgIHZhciBjb21waWxlTm9kZSA9IG5ldyBDb21waWxlTm9kZShwYXJlbnQsIHRoaXMudmlldywgdGhpcy52aWV3Lm5vZGVzLmxlbmd0aCwgcmVuZGVyTm9kZSwgYXN0KTtcbiAgICB2YXIgY3JlYXRlUmVuZGVyTm9kZSA9XG4gICAgICAgIG8uVEhJU19FWFBSLnByb3AoZmllbGROYW1lKVxuICAgICAgICAgICAgLnNldChWaWV3UHJvcGVydGllcy5yZW5kZXJlci5jYWxsTWV0aG9kKFxuICAgICAgICAgICAgICAgICdjcmVhdGVUZXh0JyxcbiAgICAgICAgICAgICAgICBbXG4gICAgICAgICAgICAgICAgICB0aGlzLl9nZXRQYXJlbnRSZW5kZXJOb2RlKHBhcmVudCksXG4gICAgICAgICAgICAgICAgICBvLmxpdGVyYWwodmFsdWUpLFxuICAgICAgICAgICAgICAgICAgdGhpcy52aWV3LmNyZWF0ZU1ldGhvZC5yZXNldERlYnVnSW5mb0V4cHIodGhpcy52aWV3Lm5vZGVzLmxlbmd0aCwgYXN0KVxuICAgICAgICAgICAgICAgIF0pKVxuICAgICAgICAgICAgLnRvU3RtdCgpO1xuICAgIHRoaXMudmlldy5ub2Rlcy5wdXNoKGNvbXBpbGVOb2RlKTtcbiAgICB0aGlzLnZpZXcuY3JlYXRlTWV0aG9kLmFkZFN0bXQoY3JlYXRlUmVuZGVyTm9kZSk7XG4gICAgdGhpcy5fYWRkUm9vdE5vZGVBbmRQcm9qZWN0KGNvbXBpbGVOb2RlLCBuZ0NvbnRlbnRJbmRleCwgcGFyZW50KTtcbiAgICByZXR1cm4gcmVuZGVyTm9kZTtcbiAgfVxuXG4gIHZpc2l0TmdDb250ZW50KGFzdDogTmdDb250ZW50QXN0LCBwYXJlbnQ6IENvbXBpbGVFbGVtZW50KTogYW55IHtcbiAgICAvLyB0aGUgcHJvamVjdGVkIG5vZGVzIG9yaWdpbmF0ZSBmcm9tIGEgZGlmZmVyZW50IHZpZXcsIHNvIHdlIGRvbid0XG4gICAgLy8gaGF2ZSBkZWJ1ZyBpbmZvcm1hdGlvbiBmb3IgdGhlbS4uLlxuICAgIHRoaXMudmlldy5jcmVhdGVNZXRob2QucmVzZXREZWJ1Z0luZm8obnVsbCwgYXN0KTtcbiAgICB2YXIgcGFyZW50UmVuZGVyTm9kZSA9IHRoaXMuX2dldFBhcmVudFJlbmRlck5vZGUocGFyZW50KTtcbiAgICB2YXIgbm9kZXNFeHByZXNzaW9uID0gVmlld1Byb3BlcnRpZXMucHJvamVjdGFibGVOb2Rlcy5rZXkoXG4gICAgICAgIG8ubGl0ZXJhbChhc3QuaW5kZXgpLFxuICAgICAgICBuZXcgby5BcnJheVR5cGUoby5pbXBvcnRUeXBlKHRoaXMudmlldy5nZW5Db25maWcucmVuZGVyVHlwZXMucmVuZGVyTm9kZSkpKTtcbiAgICBpZiAocGFyZW50UmVuZGVyTm9kZSAhPT0gby5OVUxMX0VYUFIpIHtcbiAgICAgIHRoaXMudmlldy5jcmVhdGVNZXRob2QuYWRkU3RtdChcbiAgICAgICAgICBWaWV3UHJvcGVydGllcy5yZW5kZXJlci5jYWxsTWV0aG9kKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdwcm9qZWN0Tm9kZXMnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmVudFJlbmRlck5vZGUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvLmltcG9ydEV4cHIoSWRlbnRpZmllcnMuZmxhdHRlbk5lc3RlZFZpZXdSZW5kZXJOb2RlcylcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuY2FsbEZuKFtub2Rlc0V4cHJlc3Npb25dKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0pXG4gICAgICAgICAgICAgIC50b1N0bXQoKSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLl9pc1Jvb3ROb2RlKHBhcmVudCkpIHtcbiAgICAgIGlmICh0aGlzLnZpZXcudmlld1R5cGUgIT09IFZpZXdUeXBlLkNPTVBPTkVOVCkge1xuICAgICAgICAvLyBzdG9yZSByb290IG5vZGVzIG9ubHkgZm9yIGVtYmVkZGVkL2hvc3Qgdmlld3NcbiAgICAgICAgdGhpcy52aWV3LnJvb3ROb2Rlc09yQXBwRWxlbWVudHMucHVzaChub2Rlc0V4cHJlc3Npb24pO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoaXNQcmVzZW50KHBhcmVudC5jb21wb25lbnQpICYmIGlzUHJlc2VudChhc3QubmdDb250ZW50SW5kZXgpKSB7XG4gICAgICAgIHBhcmVudC5hZGRDb250ZW50Tm9kZShhc3QubmdDb250ZW50SW5kZXgsIG5vZGVzRXhwcmVzc2lvbik7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgdmlzaXRFbGVtZW50KGFzdDogRWxlbWVudEFzdCwgcGFyZW50OiBDb21waWxlRWxlbWVudCk6IGFueSB7XG4gICAgdmFyIG5vZGVJbmRleCA9IHRoaXMudmlldy5ub2Rlcy5sZW5ndGg7XG4gICAgdmFyIGNyZWF0ZVJlbmRlck5vZGVFeHByO1xuICAgIHZhciBkZWJ1Z0NvbnRleHRFeHByID0gdGhpcy52aWV3LmNyZWF0ZU1ldGhvZC5yZXNldERlYnVnSW5mb0V4cHIobm9kZUluZGV4LCBhc3QpO1xuICAgIHZhciBjcmVhdGVFbGVtZW50RXhwciA9IFZpZXdQcm9wZXJ0aWVzLnJlbmRlcmVyLmNhbGxNZXRob2QoXG4gICAgICAgICdjcmVhdGVFbGVtZW50JyxcbiAgICAgICAgW3RoaXMuX2dldFBhcmVudFJlbmRlck5vZGUocGFyZW50KSwgby5saXRlcmFsKGFzdC5uYW1lKSwgZGVidWdDb250ZXh0RXhwcl0pO1xuICAgIGlmIChub2RlSW5kZXggPT09IDAgJiYgdGhpcy52aWV3LnZpZXdUeXBlID09PSBWaWV3VHlwZS5IT1NUKSB7XG4gICAgICBjcmVhdGVSZW5kZXJOb2RlRXhwciA9XG4gICAgICAgICAgcm9vdFNlbGVjdG9yVmFyLmlkZW50aWNhbChvLk5VTExfRVhQUilcbiAgICAgICAgICAgICAgLmNvbmRpdGlvbmFsKGNyZWF0ZUVsZW1lbnRFeHByLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgVmlld1Byb3BlcnRpZXMucmVuZGVyZXIuY2FsbE1ldGhvZCgnc2VsZWN0Um9vdEVsZW1lbnQnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBbcm9vdFNlbGVjdG9yVmFyLCBkZWJ1Z0NvbnRleHRFeHByXSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjcmVhdGVSZW5kZXJOb2RlRXhwciA9IGNyZWF0ZUVsZW1lbnRFeHByO1xuICAgIH1cbiAgICB2YXIgZmllbGROYW1lID0gYF9lbF8ke25vZGVJbmRleH1gO1xuICAgIHRoaXMudmlldy5maWVsZHMucHVzaChcbiAgICAgICAgbmV3IG8uQ2xhc3NGaWVsZChmaWVsZE5hbWUsIG8uaW1wb3J0VHlwZSh0aGlzLnZpZXcuZ2VuQ29uZmlnLnJlbmRlclR5cGVzLnJlbmRlckVsZW1lbnQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgIFtvLlN0bXRNb2RpZmllci5Qcml2YXRlXSkpO1xuICAgIHZhciBjcmVhdGVSZW5kZXJOb2RlID0gby5USElTX0VYUFIucHJvcChmaWVsZE5hbWUpLnNldChjcmVhdGVSZW5kZXJOb2RlRXhwcikudG9TdG10KCk7XG5cbiAgICB2YXIgcmVuZGVyTm9kZSA9IG8uVEhJU19FWFBSLnByb3AoZmllbGROYW1lKTtcblxuICAgIHZhciBjb21wb25lbnQgPSBhc3QuZ2V0Q29tcG9uZW50KCk7XG4gICAgdmFyIGRpcmVjdGl2ZXMgPSBhc3QuZGlyZWN0aXZlcy5tYXAoZGlyZWN0aXZlQXN0ID0+IGRpcmVjdGl2ZUFzdC5kaXJlY3RpdmUpO1xuICAgIHZhciB2YXJpYWJsZXMgPVxuICAgICAgICBfcmVhZEh0bWxBbmREaXJlY3RpdmVWYXJpYWJsZXMoYXN0LmV4cG9ydEFzVmFycywgYXN0LmRpcmVjdGl2ZXMsIHRoaXMudmlldy52aWV3VHlwZSk7XG4gICAgdGhpcy52aWV3LmNyZWF0ZU1ldGhvZC5hZGRTdG10KGNyZWF0ZVJlbmRlck5vZGUpO1xuICAgIHZhciBodG1sQXR0cnMgPSBfcmVhZEh0bWxBdHRycyhhc3QuYXR0cnMpO1xuICAgIHZhciBhdHRyTmFtZUFuZFZhbHVlcyA9IF9tZXJnZUh0bWxBbmREaXJlY3RpdmVBdHRycyhodG1sQXR0cnMsIGRpcmVjdGl2ZXMpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXR0ck5hbWVBbmRWYWx1ZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIHZhciBhdHRyTmFtZSA9IGF0dHJOYW1lQW5kVmFsdWVzW2ldWzBdO1xuICAgICAgdmFyIGF0dHJWYWx1ZSA9IGF0dHJOYW1lQW5kVmFsdWVzW2ldWzFdO1xuICAgICAgdGhpcy52aWV3LmNyZWF0ZU1ldGhvZC5hZGRTdG10KFxuICAgICAgICAgIFZpZXdQcm9wZXJ0aWVzLnJlbmRlcmVyLmNhbGxNZXRob2QoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ3NldEVsZW1lbnRBdHRyaWJ1dGUnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFtyZW5kZXJOb2RlLCBvLmxpdGVyYWwoYXR0ck5hbWUpLCBvLmxpdGVyYWwoYXR0clZhbHVlKV0pXG4gICAgICAgICAgICAgIC50b1N0bXQoKSk7XG4gICAgfVxuICAgIHZhciBjb21waWxlRWxlbWVudCA9IG5ldyBDb21waWxlRWxlbWVudChwYXJlbnQsIHRoaXMudmlldywgbm9kZUluZGV4LCByZW5kZXJOb2RlLCBhc3QsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpcmVjdGl2ZXMsIGFzdC5wcm92aWRlcnMsIHZhcmlhYmxlcyk7XG4gICAgdGhpcy52aWV3Lm5vZGVzLnB1c2goY29tcGlsZUVsZW1lbnQpO1xuICAgIHZhciBjb21wVmlld0V4cHI6IG8uUmVhZFZhckV4cHIgPSBudWxsO1xuICAgIGlmIChpc1ByZXNlbnQoY29tcG9uZW50KSkge1xuICAgICAgdmFyIG5lc3RlZENvbXBvbmVudElkZW50aWZpZXIgPVxuICAgICAgICAgIG5ldyBDb21waWxlSWRlbnRpZmllck1ldGFkYXRhKHtuYW1lOiBnZXRWaWV3RmFjdG9yeU5hbWUoY29tcG9uZW50LCAwKX0pO1xuICAgICAgdGhpcy50YXJnZXREZXBlbmRlbmNpZXMucHVzaChuZXcgVmlld0NvbXBpbGVEZXBlbmRlbmN5KGNvbXBvbmVudCwgbmVzdGVkQ29tcG9uZW50SWRlbnRpZmllcikpO1xuICAgICAgY29tcFZpZXdFeHByID0gby52YXJpYWJsZShgY29tcFZpZXdfJHtub2RlSW5kZXh9YCk7XG4gICAgICB0aGlzLnZpZXcuY3JlYXRlTWV0aG9kLmFkZFN0bXQoY29tcFZpZXdFeHByLnNldChvLmltcG9ydEV4cHIobmVzdGVkQ29tcG9uZW50SWRlbnRpZmllcilcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuY2FsbEZuKFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFZpZXdQcm9wZXJ0aWVzLnZpZXdNYW5hZ2VyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcGlsZUVsZW1lbnQuZ2V0T3JDcmVhdGVJbmplY3RvcigpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcGlsZUVsZW1lbnQuZ2V0T3JDcmVhdGVBcHBFbGVtZW50KClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdKSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnRvRGVjbFN0bXQoKSk7XG4gICAgICBjb21waWxlRWxlbWVudC5zZXRDb21wb25lbnQoY29tcG9uZW50LCBjb21wVmlld0V4cHIpO1xuICAgIH1cbiAgICBjb21waWxlRWxlbWVudC5iZWZvcmVDaGlsZHJlbigpO1xuICAgIHRoaXMuX2FkZFJvb3ROb2RlQW5kUHJvamVjdChjb21waWxlRWxlbWVudCwgYXN0Lm5nQ29udGVudEluZGV4LCBwYXJlbnQpO1xuICAgIHRlbXBsYXRlVmlzaXRBbGwodGhpcywgYXN0LmNoaWxkcmVuLCBjb21waWxlRWxlbWVudCk7XG4gICAgY29tcGlsZUVsZW1lbnQuYWZ0ZXJDaGlsZHJlbih0aGlzLnZpZXcubm9kZXMubGVuZ3RoIC0gbm9kZUluZGV4IC0gMSk7XG5cbiAgICBpZiAoaXNQcmVzZW50KGNvbXBWaWV3RXhwcikpIHtcbiAgICAgIHZhciBjb2RlR2VuQ29udGVudE5vZGVzO1xuICAgICAgaWYgKHRoaXMudmlldy5jb21wb25lbnQudHlwZS5pc0hvc3QpIHtcbiAgICAgICAgY29kZUdlbkNvbnRlbnROb2RlcyA9IFZpZXdQcm9wZXJ0aWVzLnByb2plY3RhYmxlTm9kZXM7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb2RlR2VuQ29udGVudE5vZGVzID0gby5saXRlcmFsQXJyKFxuICAgICAgICAgICAgY29tcGlsZUVsZW1lbnQuY29udGVudE5vZGVzQnlOZ0NvbnRlbnRJbmRleC5tYXAobm9kZXMgPT4gY3JlYXRlRmxhdEFycmF5KG5vZGVzKSkpO1xuICAgICAgfVxuICAgICAgdGhpcy52aWV3LmNyZWF0ZU1ldGhvZC5hZGRTdG10KFxuICAgICAgICAgIGNvbXBWaWV3RXhwci5jYWxsTWV0aG9kKCdjcmVhdGUnLCBbY29kZUdlbkNvbnRlbnROb2Rlcywgby5OVUxMX0VYUFJdKS50b1N0bXQoKSk7XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgdmlzaXRFbWJlZGRlZFRlbXBsYXRlKGFzdDogRW1iZWRkZWRUZW1wbGF0ZUFzdCwgcGFyZW50OiBDb21waWxlRWxlbWVudCk6IGFueSB7XG4gICAgdmFyIG5vZGVJbmRleCA9IHRoaXMudmlldy5ub2Rlcy5sZW5ndGg7XG4gICAgdmFyIGZpZWxkTmFtZSA9IGBfYW5jaG9yXyR7bm9kZUluZGV4fWA7XG4gICAgdGhpcy52aWV3LmZpZWxkcy5wdXNoKFxuICAgICAgICBuZXcgby5DbGFzc0ZpZWxkKGZpZWxkTmFtZSwgby5pbXBvcnRUeXBlKHRoaXMudmlldy5nZW5Db25maWcucmVuZGVyVHlwZXMucmVuZGVyQ29tbWVudCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgW28uU3RtdE1vZGlmaWVyLlByaXZhdGVdKSk7XG4gICAgdmFyIGNyZWF0ZVJlbmRlck5vZGUgPSBvLlRISVNfRVhQUi5wcm9wKGZpZWxkTmFtZSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuc2V0KFZpZXdQcm9wZXJ0aWVzLnJlbmRlcmVyLmNhbGxNZXRob2QoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdjcmVhdGVUZW1wbGF0ZUFuY2hvcicsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9nZXRQYXJlbnRSZW5kZXJOb2RlKHBhcmVudCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy52aWV3LmNyZWF0ZU1ldGhvZC5yZXNldERlYnVnSW5mb0V4cHIobm9kZUluZGV4LCBhc3QpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0pKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC50b1N0bXQoKTtcbiAgICB2YXIgcmVuZGVyTm9kZSA9IG8uVEhJU19FWFBSLnByb3AoZmllbGROYW1lKTtcblxuICAgIHZhciB0ZW1wbGF0ZVZhcmlhYmxlQmluZGluZ3MgPSBhc3QudmFycy5tYXAoXG4gICAgICAgIHZhckFzdCA9PiBbdmFyQXN0LnZhbHVlLmxlbmd0aCA+IDAgPyB2YXJBc3QudmFsdWUgOiBJTVBMSUNJVF9URU1QTEFURV9WQVIsIHZhckFzdC5uYW1lXSk7XG5cbiAgICB2YXIgZGlyZWN0aXZlcyA9IGFzdC5kaXJlY3RpdmVzLm1hcChkaXJlY3RpdmVBc3QgPT4gZGlyZWN0aXZlQXN0LmRpcmVjdGl2ZSk7XG4gICAgdmFyIGNvbXBpbGVFbGVtZW50ID0gbmV3IENvbXBpbGVFbGVtZW50KHBhcmVudCwgdGhpcy52aWV3LCBub2RlSW5kZXgsIHJlbmRlck5vZGUsIGFzdCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlyZWN0aXZlcywgYXN0LnByb3ZpZGVycywge30pO1xuICAgIHRoaXMudmlldy5ub2Rlcy5wdXNoKGNvbXBpbGVFbGVtZW50KTtcbiAgICB0aGlzLnZpZXcuY3JlYXRlTWV0aG9kLmFkZFN0bXQoY3JlYXRlUmVuZGVyTm9kZSk7XG5cbiAgICB0aGlzLm5lc3RlZFZpZXdDb3VudCsrO1xuICAgIHZhciBlbWJlZGRlZFZpZXcgPSBuZXcgQ29tcGlsZVZpZXcoXG4gICAgICAgIHRoaXMudmlldy5jb21wb25lbnQsIHRoaXMudmlldy5nZW5Db25maWcsIHRoaXMudmlldy5waXBlTWV0YXMsIG8uTlVMTF9FWFBSLFxuICAgICAgICB0aGlzLnZpZXcudmlld0luZGV4ICsgdGhpcy5uZXN0ZWRWaWV3Q291bnQsIGNvbXBpbGVFbGVtZW50LCB0ZW1wbGF0ZVZhcmlhYmxlQmluZGluZ3MpO1xuICAgIHRoaXMubmVzdGVkVmlld0NvdW50ICs9XG4gICAgICAgIGJ1aWxkVmlldyhlbWJlZGRlZFZpZXcsIGFzdC5jaGlsZHJlbiwgdGhpcy50YXJnZXREZXBlbmRlbmNpZXMsIHRoaXMudGFyZ2V0U3RhdGVtZW50cyk7XG5cbiAgICBjb21waWxlRWxlbWVudC5iZWZvcmVDaGlsZHJlbigpO1xuICAgIHRoaXMuX2FkZFJvb3ROb2RlQW5kUHJvamVjdChjb21waWxlRWxlbWVudCwgYXN0Lm5nQ29udGVudEluZGV4LCBwYXJlbnQpO1xuICAgIGNvbXBpbGVFbGVtZW50LmFmdGVyQ2hpbGRyZW4oMCk7XG5cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHZpc2l0QXR0cihhc3Q6IEF0dHJBc3QsIGN0eDogYW55KTogYW55IHsgcmV0dXJuIG51bGw7IH1cbiAgdmlzaXREaXJlY3RpdmUoYXN0OiBEaXJlY3RpdmVBc3QsIGN0eDogYW55KTogYW55IHsgcmV0dXJuIG51bGw7IH1cbiAgdmlzaXRFdmVudChhc3Q6IEJvdW5kRXZlbnRBc3QsIGV2ZW50VGFyZ2V0QW5kTmFtZXM6IE1hcDxzdHJpbmcsIEJvdW5kRXZlbnRBc3Q+KTogYW55IHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHZpc2l0VmFyaWFibGUoYXN0OiBWYXJpYWJsZUFzdCwgY3R4OiBhbnkpOiBhbnkgeyByZXR1cm4gbnVsbDsgfVxuICB2aXNpdERpcmVjdGl2ZVByb3BlcnR5KGFzdDogQm91bmREaXJlY3RpdmVQcm9wZXJ0eUFzdCwgY29udGV4dDogYW55KTogYW55IHsgcmV0dXJuIG51bGw7IH1cbiAgdmlzaXRFbGVtZW50UHJvcGVydHkoYXN0OiBCb3VuZEVsZW1lbnRQcm9wZXJ0eUFzdCwgY29udGV4dDogYW55KTogYW55IHsgcmV0dXJuIG51bGw7IH1cbn1cblxuZnVuY3Rpb24gX21lcmdlSHRtbEFuZERpcmVjdGl2ZUF0dHJzKGRlY2xhcmVkSHRtbEF0dHJzOiB7W2tleTogc3RyaW5nXTogc3RyaW5nfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXJlY3RpdmVzOiBDb21waWxlRGlyZWN0aXZlTWV0YWRhdGFbXSk6IHN0cmluZ1tdW10ge1xuICB2YXIgcmVzdWx0OiB7W2tleTogc3RyaW5nXTogc3RyaW5nfSA9IHt9O1xuICBTdHJpbmdNYXBXcmFwcGVyLmZvckVhY2goZGVjbGFyZWRIdG1sQXR0cnMsICh2YWx1ZSwga2V5KSA9PiB7IHJlc3VsdFtrZXldID0gdmFsdWU7IH0pO1xuICBkaXJlY3RpdmVzLmZvckVhY2goZGlyZWN0aXZlTWV0YSA9PiB7XG4gICAgU3RyaW5nTWFwV3JhcHBlci5mb3JFYWNoKGRpcmVjdGl2ZU1ldGEuaG9zdEF0dHJpYnV0ZXMsICh2YWx1ZSwgbmFtZSkgPT4ge1xuICAgICAgdmFyIHByZXZWYWx1ZSA9IHJlc3VsdFtuYW1lXTtcbiAgICAgIHJlc3VsdFtuYW1lXSA9IGlzUHJlc2VudChwcmV2VmFsdWUpID8gbWVyZ2VBdHRyaWJ1dGVWYWx1ZShuYW1lLCBwcmV2VmFsdWUsIHZhbHVlKSA6IHZhbHVlO1xuICAgIH0pO1xuICB9KTtcbiAgcmV0dXJuIG1hcFRvS2V5VmFsdWVBcnJheShyZXN1bHQpO1xufVxuXG5mdW5jdGlvbiBfcmVhZEh0bWxBdHRycyhhdHRyczogQXR0ckFzdFtdKToge1trZXk6IHN0cmluZ106IHN0cmluZ30ge1xuICB2YXIgaHRtbEF0dHJzOiB7W2tleTogc3RyaW5nXTogc3RyaW5nfSA9IHt9O1xuICBhdHRycy5mb3JFYWNoKChhc3QpID0+IHsgaHRtbEF0dHJzW2FzdC5uYW1lXSA9IGFzdC52YWx1ZTsgfSk7XG4gIHJldHVybiBodG1sQXR0cnM7XG59XG5cbmZ1bmN0aW9uIF9yZWFkSHRtbEFuZERpcmVjdGl2ZVZhcmlhYmxlcyhlbGVtZW50RXhwb3J0QXNWYXJzOiBWYXJpYWJsZUFzdFtdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpcmVjdGl2ZXM6IERpcmVjdGl2ZUFzdFtdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZpZXdUeXBlOiBWaWV3VHlwZSk6IHtba2V5OiBzdHJpbmddOiBDb21waWxlVG9rZW5NZXRhZGF0YX0ge1xuICB2YXIgdmFyaWFibGVzOiB7W2tleTogc3RyaW5nXTogQ29tcGlsZVRva2VuTWV0YWRhdGF9ID0ge307XG4gIHZhciBjb21wb25lbnQ6IENvbXBpbGVEaXJlY3RpdmVNZXRhZGF0YSA9IG51bGw7XG4gIGRpcmVjdGl2ZXMuZm9yRWFjaCgoZGlyZWN0aXZlKSA9PiB7XG4gICAgaWYgKGRpcmVjdGl2ZS5kaXJlY3RpdmUuaXNDb21wb25lbnQpIHtcbiAgICAgIGNvbXBvbmVudCA9IGRpcmVjdGl2ZS5kaXJlY3RpdmU7XG4gICAgfVxuICAgIGRpcmVjdGl2ZS5leHBvcnRBc1ZhcnMuZm9yRWFjaChcbiAgICAgICAgdmFyQXN0ID0+IHsgdmFyaWFibGVzW3ZhckFzdC5uYW1lXSA9IGlkZW50aWZpZXJUb2tlbihkaXJlY3RpdmUuZGlyZWN0aXZlLnR5cGUpOyB9KTtcbiAgfSk7XG4gIGVsZW1lbnRFeHBvcnRBc1ZhcnMuZm9yRWFjaCgodmFyQXN0KSA9PiB7XG4gICAgdmFyaWFibGVzW3ZhckFzdC5uYW1lXSA9IGlzUHJlc2VudChjb21wb25lbnQpID8gaWRlbnRpZmllclRva2VuKGNvbXBvbmVudC50eXBlKSA6IG51bGw7XG4gIH0pO1xuICBpZiAodmlld1R5cGUgPT09IFZpZXdUeXBlLkhPU1QpIHtcbiAgICB2YXJpYWJsZXNbSE9TVF9WSUVXX0VMRU1FTlRfTkFNRV0gPSBudWxsO1xuICB9XG4gIHJldHVybiB2YXJpYWJsZXM7XG59XG5cbmZ1bmN0aW9uIG1lcmdlQXR0cmlidXRlVmFsdWUoYXR0ck5hbWU6IHN0cmluZywgYXR0clZhbHVlMTogc3RyaW5nLCBhdHRyVmFsdWUyOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoYXR0ck5hbWUgPT0gQ0xBU1NfQVRUUiB8fCBhdHRyTmFtZSA9PSBTVFlMRV9BVFRSKSB7XG4gICAgcmV0dXJuIGAke2F0dHJWYWx1ZTF9ICR7YXR0clZhbHVlMn1gO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBhdHRyVmFsdWUyO1xuICB9XG59XG5cbmZ1bmN0aW9uIG1hcFRvS2V5VmFsdWVBcnJheShkYXRhOiB7W2tleTogc3RyaW5nXTogc3RyaW5nfSk6IHN0cmluZ1tdW10ge1xuICB2YXIgZW50cnlBcnJheSA9IFtdO1xuICBTdHJpbmdNYXBXcmFwcGVyLmZvckVhY2goZGF0YSwgKHZhbHVlLCBuYW1lKSA9PiB7IGVudHJ5QXJyYXkucHVzaChbbmFtZSwgdmFsdWVdKTsgfSk7XG4gIC8vIFdlIG5lZWQgdG8gc29ydCB0byBnZXQgYSBkZWZpbmVkIG91dHB1dCBvcmRlclxuICAvLyBmb3IgdGVzdHMgYW5kIGZvciBjYWNoaW5nIGdlbmVyYXRlZCBhcnRpZmFjdHMuLi5cbiAgTGlzdFdyYXBwZXIuc29ydChlbnRyeUFycmF5LCAoZW50cnkxLCBlbnRyeTIpID0+IFN0cmluZ1dyYXBwZXIuY29tcGFyZShlbnRyeTFbMF0sIGVudHJ5MlswXSkpO1xuICB2YXIga2V5VmFsdWVBcnJheSA9IFtdO1xuICBlbnRyeUFycmF5LmZvckVhY2goKGVudHJ5KSA9PiB7IGtleVZhbHVlQXJyYXkucHVzaChbZW50cnlbMF0sIGVudHJ5WzFdXSk7IH0pO1xuICByZXR1cm4ga2V5VmFsdWVBcnJheTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVmlld1RvcExldmVsU3RtdHModmlldzogQ29tcGlsZVZpZXcsIHRhcmdldFN0YXRlbWVudHM6IG8uU3RhdGVtZW50W10pIHtcbiAgdmFyIG5vZGVEZWJ1Z0luZm9zVmFyOiBvLkV4cHJlc3Npb24gPSBvLk5VTExfRVhQUjtcbiAgaWYgKHZpZXcuZ2VuQ29uZmlnLmdlbkRlYnVnSW5mbykge1xuICAgIG5vZGVEZWJ1Z0luZm9zVmFyID0gby52YXJpYWJsZShgbm9kZURlYnVnSW5mb3NfJHt2aWV3LmNvbXBvbmVudC50eXBlLm5hbWV9JHt2aWV3LnZpZXdJbmRleH1gKTtcbiAgICB0YXJnZXRTdGF0ZW1lbnRzLnB1c2goXG4gICAgICAgICg8by5SZWFkVmFyRXhwcj5ub2RlRGVidWdJbmZvc1ZhcilcbiAgICAgICAgICAgIC5zZXQoby5saXRlcmFsQXJyKHZpZXcubm9kZXMubWFwKGNyZWF0ZVN0YXRpY05vZGVEZWJ1Z0luZm8pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmV3IG8uQXJyYXlUeXBlKG5ldyBvLkV4dGVybmFsVHlwZShJZGVudGlmaWVycy5TdGF0aWNOb2RlRGVidWdJbmZvKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBbby5UeXBlTW9kaWZpZXIuQ29uc3RdKSkpXG4gICAgICAgICAgICAudG9EZWNsU3RtdChudWxsLCBbby5TdG10TW9kaWZpZXIuRmluYWxdKSk7XG4gIH1cblxuXG4gIHZhciByZW5kZXJDb21wVHlwZVZhcjogby5SZWFkVmFyRXhwciA9IG8udmFyaWFibGUoYHJlbmRlclR5cGVfJHt2aWV3LmNvbXBvbmVudC50eXBlLm5hbWV9YCk7XG4gIGlmICh2aWV3LnZpZXdJbmRleCA9PT0gMCkge1xuICAgIHRhcmdldFN0YXRlbWVudHMucHVzaChyZW5kZXJDb21wVHlwZVZhci5zZXQoby5OVUxMX0VYUFIpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAudG9EZWNsU3RtdChvLmltcG9ydFR5cGUoSWRlbnRpZmllcnMuUmVuZGVyQ29tcG9uZW50VHlwZSkpKTtcbiAgfVxuXG4gIHZhciB2aWV3Q2xhc3MgPSBjcmVhdGVWaWV3Q2xhc3ModmlldywgcmVuZGVyQ29tcFR5cGVWYXIsIG5vZGVEZWJ1Z0luZm9zVmFyKTtcbiAgdGFyZ2V0U3RhdGVtZW50cy5wdXNoKHZpZXdDbGFzcyk7XG4gIHRhcmdldFN0YXRlbWVudHMucHVzaChjcmVhdGVWaWV3RmFjdG9yeSh2aWV3LCB2aWV3Q2xhc3MsIHJlbmRlckNvbXBUeXBlVmFyKSk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVN0YXRpY05vZGVEZWJ1Z0luZm8obm9kZTogQ29tcGlsZU5vZGUpOiBvLkV4cHJlc3Npb24ge1xuICB2YXIgY29tcGlsZUVsZW1lbnQgPSBub2RlIGluc3RhbmNlb2YgQ29tcGlsZUVsZW1lbnQgPyBub2RlIDogbnVsbDtcbiAgdmFyIHByb3ZpZGVyVG9rZW5zOiBvLkV4cHJlc3Npb25bXSA9IFtdO1xuICB2YXIgY29tcG9uZW50VG9rZW46IG8uRXhwcmVzc2lvbiA9IG8uTlVMTF9FWFBSO1xuICB2YXIgdmFyVG9rZW5FbnRyaWVzID0gW107XG4gIGlmIChpc1ByZXNlbnQoY29tcGlsZUVsZW1lbnQpKSB7XG4gICAgcHJvdmlkZXJUb2tlbnMgPSBjb21waWxlRWxlbWVudC5nZXRQcm92aWRlclRva2VucygpO1xuICAgIGlmIChpc1ByZXNlbnQoY29tcGlsZUVsZW1lbnQuY29tcG9uZW50KSkge1xuICAgICAgY29tcG9uZW50VG9rZW4gPSBjcmVhdGVEaVRva2VuRXhwcmVzc2lvbihpZGVudGlmaWVyVG9rZW4oY29tcGlsZUVsZW1lbnQuY29tcG9uZW50LnR5cGUpKTtcbiAgICB9XG4gICAgU3RyaW5nTWFwV3JhcHBlci5mb3JFYWNoKGNvbXBpbGVFbGVtZW50LnZhcmlhYmxlVG9rZW5zLCAodG9rZW4sIHZhck5hbWUpID0+IHtcbiAgICAgIHZhclRva2VuRW50cmllcy5wdXNoKFxuICAgICAgICAgIFt2YXJOYW1lLCBpc1ByZXNlbnQodG9rZW4pID8gY3JlYXRlRGlUb2tlbkV4cHJlc3Npb24odG9rZW4pIDogby5OVUxMX0VYUFJdKTtcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gby5pbXBvcnRFeHByKElkZW50aWZpZXJzLlN0YXRpY05vZGVEZWJ1Z0luZm8pXG4gICAgICAuaW5zdGFudGlhdGUoXG4gICAgICAgICAgW1xuICAgICAgICAgICAgby5saXRlcmFsQXJyKHByb3ZpZGVyVG9rZW5zLCBuZXcgby5BcnJheVR5cGUoby5EWU5BTUlDX1RZUEUsIFtvLlR5cGVNb2RpZmllci5Db25zdF0pKSxcbiAgICAgICAgICAgIGNvbXBvbmVudFRva2VuLFxuICAgICAgICAgICAgby5saXRlcmFsTWFwKHZhclRva2VuRW50cmllcywgbmV3IG8uTWFwVHlwZShvLkRZTkFNSUNfVFlQRSwgW28uVHlwZU1vZGlmaWVyLkNvbnN0XSkpXG4gICAgICAgICAgXSxcbiAgICAgICAgICBvLmltcG9ydFR5cGUoSWRlbnRpZmllcnMuU3RhdGljTm9kZURlYnVnSW5mbywgbnVsbCwgW28uVHlwZU1vZGlmaWVyLkNvbnN0XSkpO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVWaWV3Q2xhc3ModmlldzogQ29tcGlsZVZpZXcsIHJlbmRlckNvbXBUeXBlVmFyOiBvLlJlYWRWYXJFeHByLFxuICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVEZWJ1Z0luZm9zVmFyOiBvLkV4cHJlc3Npb24pOiBvLkNsYXNzU3RtdCB7XG4gIHZhciBlbXB0eVRlbXBsYXRlVmFyaWFibGVCaW5kaW5ncyA9XG4gICAgICB2aWV3LnRlbXBsYXRlVmFyaWFibGVCaW5kaW5ncy5tYXAoKGVudHJ5KSA9PiBbZW50cnlbMF0sIG8uTlVMTF9FWFBSXSk7XG4gIHZhciB2aWV3Q29uc3RydWN0b3JBcmdzID0gW1xuICAgIG5ldyBvLkZuUGFyYW0oVmlld0NvbnN0cnVjdG9yVmFycy52aWV3TWFuYWdlci5uYW1lLCBvLmltcG9ydFR5cGUoSWRlbnRpZmllcnMuQXBwVmlld01hbmFnZXJfKSksXG4gICAgbmV3IG8uRm5QYXJhbShWaWV3Q29uc3RydWN0b3JWYXJzLnBhcmVudEluamVjdG9yLm5hbWUsIG8uaW1wb3J0VHlwZShJZGVudGlmaWVycy5JbmplY3RvcikpLFxuICAgIG5ldyBvLkZuUGFyYW0oVmlld0NvbnN0cnVjdG9yVmFycy5kZWNsYXJhdGlvbkVsLm5hbWUsIG8uaW1wb3J0VHlwZShJZGVudGlmaWVycy5BcHBFbGVtZW50KSlcbiAgXTtcbiAgdmFyIHZpZXdDb25zdHJ1Y3RvciA9IG5ldyBvLkNsYXNzTWV0aG9kKG51bGwsIHZpZXdDb25zdHJ1Y3RvckFyZ3MsIFtcbiAgICBvLlNVUEVSX0VYUFIuY2FsbEZuKFtcbiAgICAgICAgICAgICAgICAgIG8udmFyaWFibGUodmlldy5jbGFzc05hbWUpLFxuICAgICAgICAgICAgICAgICAgcmVuZGVyQ29tcFR5cGVWYXIsXG4gICAgICAgICAgICAgICAgICBWaWV3VHlwZUVudW0uZnJvbVZhbHVlKHZpZXcudmlld1R5cGUpLFxuICAgICAgICAgICAgICAgICAgby5saXRlcmFsTWFwKGVtcHR5VGVtcGxhdGVWYXJpYWJsZUJpbmRpbmdzKSxcbiAgICAgICAgICAgICAgICAgIFZpZXdDb25zdHJ1Y3RvclZhcnMudmlld01hbmFnZXIsXG4gICAgICAgICAgICAgICAgICBWaWV3Q29uc3RydWN0b3JWYXJzLnBhcmVudEluamVjdG9yLFxuICAgICAgICAgICAgICAgICAgVmlld0NvbnN0cnVjdG9yVmFycy5kZWNsYXJhdGlvbkVsLFxuICAgICAgICAgICAgICAgICAgQ2hhbmdlRGV0ZWN0aW9uU3RyYXRlZ3lFbnVtLmZyb21WYWx1ZShnZXRDaGFuZ2VEZXRlY3Rpb25Nb2RlKHZpZXcpKSxcbiAgICAgICAgICAgICAgICAgIG8ubGl0ZXJhbCh2aWV3LmxpdGVyYWxBcnJheUNvdW50KSxcbiAgICAgICAgICAgICAgICAgIG8ubGl0ZXJhbCh2aWV3LmxpdGVyYWxNYXBDb3VudCksXG4gICAgICAgICAgICAgICAgICBub2RlRGVidWdJbmZvc1ZhclxuICAgICAgICAgICAgICAgIF0pXG4gICAgICAgIC50b1N0bXQoKVxuICBdKTtcblxuICB2YXIgdmlld01ldGhvZHMgPSBbXG4gICAgbmV3IG8uQ2xhc3NNZXRob2QoJ2NyZWF0ZUludGVybmFsJywgW25ldyBvLkZuUGFyYW0ocm9vdFNlbGVjdG9yVmFyLm5hbWUsIG8uU1RSSU5HX1RZUEUpXSxcbiAgICAgICAgICAgICAgICAgICAgICBnZW5lcmF0ZUNyZWF0ZU1ldGhvZCh2aWV3KSksXG4gICAgbmV3IG8uQ2xhc3NNZXRob2QoXG4gICAgICAgICdpbmplY3RvckdldEludGVybmFsJyxcbiAgICAgICAgW1xuICAgICAgICAgIG5ldyBvLkZuUGFyYW0oSW5qZWN0TWV0aG9kVmFycy50b2tlbi5uYW1lLCBvLkRZTkFNSUNfVFlQRSksXG4gICAgICAgICAgLy8gTm90ZTogQ2FuJ3QgdXNlIG8uSU5UX1RZUEUgaGVyZSBhcyB0aGUgbWV0aG9kIGluIEFwcFZpZXcgdXNlcyBudW1iZXJcbiAgICAgICAgICBuZXcgby5GblBhcmFtKEluamVjdE1ldGhvZFZhcnMucmVxdWVzdE5vZGVJbmRleC5uYW1lLCBvLk5VTUJFUl9UWVBFKSxcbiAgICAgICAgICBuZXcgby5GblBhcmFtKEluamVjdE1ldGhvZFZhcnMubm90Rm91bmRSZXN1bHQubmFtZSwgby5EWU5BTUlDX1RZUEUpXG4gICAgICAgIF0sXG4gICAgICAgIGFkZFJldHVyblZhbHVlZk5vdEVtcHR5KHZpZXcuaW5qZWN0b3JHZXRNZXRob2QuZmluaXNoKCksIEluamVjdE1ldGhvZFZhcnMubm90Rm91bmRSZXN1bHQpLFxuICAgICAgICBvLkRZTkFNSUNfVFlQRSksXG4gICAgbmV3IG8uQ2xhc3NNZXRob2QoJ2RldGVjdENoYW5nZXNJbnRlcm5hbCcsXG4gICAgICAgICAgICAgICAgICAgICAgW25ldyBvLkZuUGFyYW0oRGV0ZWN0Q2hhbmdlc1ZhcnMudGhyb3dPbkNoYW5nZS5uYW1lLCBvLkJPT0xfVFlQRSldLFxuICAgICAgICAgICAgICAgICAgICAgIGdlbmVyYXRlRGV0ZWN0Q2hhbmdlc01ldGhvZCh2aWV3KSksXG4gICAgbmV3IG8uQ2xhc3NNZXRob2QoJ2RpcnR5UGFyZW50UXVlcmllc0ludGVybmFsJywgW10sIHZpZXcuZGlydHlQYXJlbnRRdWVyaWVzTWV0aG9kLmZpbmlzaCgpKSxcbiAgICBuZXcgby5DbGFzc01ldGhvZCgnZGVzdHJveUludGVybmFsJywgW10sIHZpZXcuZGVzdHJveU1ldGhvZC5maW5pc2goKSlcbiAgXS5jb25jYXQodmlldy5ldmVudEhhbmRsZXJNZXRob2RzKTtcbiAgdmFyIHZpZXdDbGFzcyA9IG5ldyBvLkNsYXNzU3RtdChcbiAgICAgIHZpZXcuY2xhc3NOYW1lLCBvLmltcG9ydEV4cHIoSWRlbnRpZmllcnMuQXBwVmlldywgW2dldENvbnRleHRUeXBlKHZpZXcpXSksIHZpZXcuZmllbGRzLFxuICAgICAgdmlldy5nZXR0ZXJzLCB2aWV3Q29uc3RydWN0b3IsIHZpZXdNZXRob2RzLmZpbHRlcigobWV0aG9kKSA9PiBtZXRob2QuYm9keS5sZW5ndGggPiAwKSk7XG4gIHJldHVybiB2aWV3Q2xhc3M7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVZpZXdGYWN0b3J5KHZpZXc6IENvbXBpbGVWaWV3LCB2aWV3Q2xhc3M6IG8uQ2xhc3NTdG10LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVuZGVyQ29tcFR5cGVWYXI6IG8uUmVhZFZhckV4cHIpOiBvLlN0YXRlbWVudCB7XG4gIHZhciB2aWV3RmFjdG9yeUFyZ3MgPSBbXG4gICAgbmV3IG8uRm5QYXJhbShWaWV3Q29uc3RydWN0b3JWYXJzLnZpZXdNYW5hZ2VyLm5hbWUsIG8uaW1wb3J0VHlwZShJZGVudGlmaWVycy5BcHBWaWV3TWFuYWdlcl8pKSxcbiAgICBuZXcgby5GblBhcmFtKFZpZXdDb25zdHJ1Y3RvclZhcnMucGFyZW50SW5qZWN0b3IubmFtZSwgby5pbXBvcnRUeXBlKElkZW50aWZpZXJzLkluamVjdG9yKSksXG4gICAgbmV3IG8uRm5QYXJhbShWaWV3Q29uc3RydWN0b3JWYXJzLmRlY2xhcmF0aW9uRWwubmFtZSwgby5pbXBvcnRUeXBlKElkZW50aWZpZXJzLkFwcEVsZW1lbnQpKVxuICBdO1xuICB2YXIgaW5pdFJlbmRlckNvbXBUeXBlU3RtdHMgPSBbXTtcbiAgdmFyIHRlbXBsYXRlVXJsSW5mbztcbiAgaWYgKHZpZXcuY29tcG9uZW50LnRlbXBsYXRlLnRlbXBsYXRlVXJsID09IHZpZXcuY29tcG9uZW50LnR5cGUubW9kdWxlVXJsKSB7XG4gICAgdGVtcGxhdGVVcmxJbmZvID1cbiAgICAgICAgYCR7dmlldy5jb21wb25lbnQudHlwZS5tb2R1bGVVcmx9IGNsYXNzICR7dmlldy5jb21wb25lbnQudHlwZS5uYW1lfSAtIGlubGluZSB0ZW1wbGF0ZWA7XG4gIH0gZWxzZSB7XG4gICAgdGVtcGxhdGVVcmxJbmZvID0gdmlldy5jb21wb25lbnQudGVtcGxhdGUudGVtcGxhdGVVcmw7XG4gIH1cbiAgaWYgKHZpZXcudmlld0luZGV4ID09PSAwKSB7XG4gICAgaW5pdFJlbmRlckNvbXBUeXBlU3RtdHMgPSBbXG4gICAgICBuZXcgby5JZlN0bXQocmVuZGVyQ29tcFR5cGVWYXIuaWRlbnRpY2FsKG8uTlVMTF9FWFBSKSxcbiAgICAgICAgICAgICAgICAgICBbXG4gICAgICAgICAgICAgICAgICAgICByZW5kZXJDb21wVHlwZVZhci5zZXQoVmlld0NvbnN0cnVjdG9yVmFycy52aWV3TWFuYWdlclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuY2FsbE1ldGhvZCgnY3JlYXRlUmVuZGVyQ29tcG9uZW50VHlwZScsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvLmxpdGVyYWwodGVtcGxhdGVVcmxJbmZvKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvLmxpdGVyYWwoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZpZXcuY29tcG9uZW50LnRlbXBsYXRlLm5nQ29udGVudFNlbGVjdG9ycy5sZW5ndGgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFZpZXdFbmNhcHN1bGF0aW9uRW51bS5mcm9tVmFsdWUodmlldy5jb21wb25lbnQudGVtcGxhdGUuZW5jYXBzdWxhdGlvbiksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmlldy5zdHlsZXNcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSkpXG4gICAgICAgICAgICAgICAgICAgICAgICAgLnRvU3RtdCgpXG4gICAgICAgICAgICAgICAgICAgXSlcbiAgICBdO1xuICB9XG4gIHJldHVybiBvLmZuKHZpZXdGYWN0b3J5QXJncywgaW5pdFJlbmRlckNvbXBUeXBlU3RtdHMuY29uY2F0KFtcbiAgICAgICAgICAgIG5ldyBvLlJldHVyblN0YXRlbWVudChvLnZhcmlhYmxlKHZpZXdDbGFzcy5uYW1lKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuaW5zdGFudGlhdGUodmlld0NsYXNzLmNvbnN0cnVjdG9yTWV0aG9kLnBhcmFtcy5tYXAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAocGFyYW0pID0+IG8udmFyaWFibGUocGFyYW0ubmFtZSkpKSlcbiAgICAgICAgICBdKSxcbiAgICAgICAgICAgICAgby5pbXBvcnRUeXBlKElkZW50aWZpZXJzLkFwcFZpZXcsIFtnZXRDb250ZXh0VHlwZSh2aWV3KV0pKVxuICAgICAgLnRvRGVjbFN0bXQodmlldy52aWV3RmFjdG9yeS5uYW1lLCBbby5TdG10TW9kaWZpZXIuRmluYWxdKTtcbn1cblxuZnVuY3Rpb24gZ2VuZXJhdGVDcmVhdGVNZXRob2QodmlldzogQ29tcGlsZVZpZXcpOiBvLlN0YXRlbWVudFtdIHtcbiAgdmFyIHBhcmVudFJlbmRlck5vZGVFeHByOiBvLkV4cHJlc3Npb24gPSBvLk5VTExfRVhQUjtcbiAgdmFyIHBhcmVudFJlbmRlck5vZGVTdG10cyA9IFtdO1xuICBpZiAodmlldy52aWV3VHlwZSA9PT0gVmlld1R5cGUuQ09NUE9ORU5UKSB7XG4gICAgcGFyZW50UmVuZGVyTm9kZUV4cHIgPSBWaWV3UHJvcGVydGllcy5yZW5kZXJlci5jYWxsTWV0aG9kKFxuICAgICAgICAnY3JlYXRlVmlld1Jvb3QnLCBbby5USElTX0VYUFIucHJvcCgnZGVjbGFyYXRpb25BcHBFbGVtZW50JykucHJvcCgnbmF0aXZlRWxlbWVudCcpXSk7XG4gICAgcGFyZW50UmVuZGVyTm9kZVN0bXRzID0gW1xuICAgICAgcGFyZW50UmVuZGVyTm9kZVZhci5zZXQocGFyZW50UmVuZGVyTm9kZUV4cHIpXG4gICAgICAgICAgLnRvRGVjbFN0bXQoby5pbXBvcnRUeXBlKHZpZXcuZ2VuQ29uZmlnLnJlbmRlclR5cGVzLnJlbmRlck5vZGUpLCBbby5TdG10TW9kaWZpZXIuRmluYWxdKVxuICAgIF07XG4gIH1cbiAgcmV0dXJuIHBhcmVudFJlbmRlck5vZGVTdG10cy5jb25jYXQodmlldy5jcmVhdGVNZXRob2QuZmluaXNoKCkpXG4gICAgICAuY29uY2F0KFtcbiAgICAgICAgby5USElTX0VYUFIuY2FsbE1ldGhvZCgnaW5pdCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY3JlYXRlRmxhdEFycmF5KHZpZXcucm9vdE5vZGVzT3JBcHBFbGVtZW50cyksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvLmxpdGVyYWxBcnIodmlldy5ub2Rlcy5tYXAobm9kZSA9PiBub2RlLnJlbmRlck5vZGUpKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG8ubGl0ZXJhbE1hcCh2aWV3Lm5hbWVkQXBwRWxlbWVudHMpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgby5saXRlcmFsQXJyKHZpZXcuZGlzcG9zYWJsZXMpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgby5saXRlcmFsQXJyKHZpZXcuc3Vic2NyaXB0aW9ucylcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdKVxuICAgICAgICAgICAgLnRvU3RtdCgpXG4gICAgICBdKTtcbn1cblxuZnVuY3Rpb24gZ2VuZXJhdGVEZXRlY3RDaGFuZ2VzTWV0aG9kKHZpZXc6IENvbXBpbGVWaWV3KTogby5TdGF0ZW1lbnRbXSB7XG4gIHZhciBzdG10cyA9IFtdO1xuICBpZiAodmlldy5kZXRlY3RDaGFuZ2VzSW5JbnB1dHNNZXRob2QuaXNFbXB0eSgpICYmIHZpZXcudXBkYXRlQ29udGVudFF1ZXJpZXNNZXRob2QuaXNFbXB0eSgpICYmXG4gICAgICB2aWV3LmFmdGVyQ29udGVudExpZmVjeWNsZUNhbGxiYWNrc01ldGhvZC5pc0VtcHR5KCkgJiZcbiAgICAgIHZpZXcuZGV0ZWN0Q2hhbmdlc0hvc3RQcm9wZXJ0aWVzTWV0aG9kLmlzRW1wdHkoKSAmJiB2aWV3LnVwZGF0ZVZpZXdRdWVyaWVzTWV0aG9kLmlzRW1wdHkoKSAmJlxuICAgICAgdmlldy5hZnRlclZpZXdMaWZlY3ljbGVDYWxsYmFja3NNZXRob2QuaXNFbXB0eSgpKSB7XG4gICAgcmV0dXJuIHN0bXRzO1xuICB9XG4gIExpc3RXcmFwcGVyLmFkZEFsbChzdG10cywgdmlldy5kZXRlY3RDaGFuZ2VzSW5JbnB1dHNNZXRob2QuZmluaXNoKCkpO1xuICBzdG10cy5wdXNoKFxuICAgICAgby5USElTX0VYUFIuY2FsbE1ldGhvZCgnZGV0ZWN0Q29udGVudENoaWxkcmVuQ2hhbmdlcycsIFtEZXRlY3RDaGFuZ2VzVmFycy50aHJvd09uQ2hhbmdlXSlcbiAgICAgICAgICAudG9TdG10KCkpO1xuICB2YXIgYWZ0ZXJDb250ZW50U3RtdHMgPSB2aWV3LnVwZGF0ZUNvbnRlbnRRdWVyaWVzTWV0aG9kLmZpbmlzaCgpLmNvbmNhdChcbiAgICAgIHZpZXcuYWZ0ZXJDb250ZW50TGlmZWN5Y2xlQ2FsbGJhY2tzTWV0aG9kLmZpbmlzaCgpKTtcbiAgaWYgKGFmdGVyQ29udGVudFN0bXRzLmxlbmd0aCA+IDApIHtcbiAgICBzdG10cy5wdXNoKG5ldyBvLklmU3RtdChvLm5vdChEZXRlY3RDaGFuZ2VzVmFycy50aHJvd09uQ2hhbmdlKSwgYWZ0ZXJDb250ZW50U3RtdHMpKTtcbiAgfVxuICBMaXN0V3JhcHBlci5hZGRBbGwoc3RtdHMsIHZpZXcuZGV0ZWN0Q2hhbmdlc0hvc3RQcm9wZXJ0aWVzTWV0aG9kLmZpbmlzaCgpKTtcbiAgc3RtdHMucHVzaChvLlRISVNfRVhQUi5jYWxsTWV0aG9kKCdkZXRlY3RWaWV3Q2hpbGRyZW5DaGFuZ2VzJywgW0RldGVjdENoYW5nZXNWYXJzLnRocm93T25DaGFuZ2VdKVxuICAgICAgICAgICAgICAgICAudG9TdG10KCkpO1xuICB2YXIgYWZ0ZXJWaWV3U3RtdHMgPVxuICAgICAgdmlldy51cGRhdGVWaWV3UXVlcmllc01ldGhvZC5maW5pc2goKS5jb25jYXQodmlldy5hZnRlclZpZXdMaWZlY3ljbGVDYWxsYmFja3NNZXRob2QuZmluaXNoKCkpO1xuICBpZiAoYWZ0ZXJWaWV3U3RtdHMubGVuZ3RoID4gMCkge1xuICAgIHN0bXRzLnB1c2gobmV3IG8uSWZTdG10KG8ubm90KERldGVjdENoYW5nZXNWYXJzLnRocm93T25DaGFuZ2UpLCBhZnRlclZpZXdTdG10cykpO1xuICB9XG5cbiAgdmFyIHZhclN0bXRzID0gW107XG4gIHZhciByZWFkVmFycyA9IG8uZmluZFJlYWRWYXJOYW1lcyhzdG10cyk7XG4gIGlmIChTZXRXcmFwcGVyLmhhcyhyZWFkVmFycywgRGV0ZWN0Q2hhbmdlc1ZhcnMuY2hhbmdlZC5uYW1lKSkge1xuICAgIHZhclN0bXRzLnB1c2goRGV0ZWN0Q2hhbmdlc1ZhcnMuY2hhbmdlZC5zZXQoby5saXRlcmFsKHRydWUpKS50b0RlY2xTdG10KG8uQk9PTF9UWVBFKSk7XG4gIH1cbiAgaWYgKFNldFdyYXBwZXIuaGFzKHJlYWRWYXJzLCBEZXRlY3RDaGFuZ2VzVmFycy5jaGFuZ2VzLm5hbWUpKSB7XG4gICAgdmFyU3RtdHMucHVzaChEZXRlY3RDaGFuZ2VzVmFycy5jaGFuZ2VzLnNldChvLk5VTExfRVhQUilcbiAgICAgICAgICAgICAgICAgICAgICAudG9EZWNsU3RtdChuZXcgby5NYXBUeXBlKG8uaW1wb3J0VHlwZShJZGVudGlmaWVycy5TaW1wbGVDaGFuZ2UpKSkpO1xuICB9XG4gIGlmIChTZXRXcmFwcGVyLmhhcyhyZWFkVmFycywgRGV0ZWN0Q2hhbmdlc1ZhcnMudmFsVW53cmFwcGVyLm5hbWUpKSB7XG4gICAgdmFyU3RtdHMucHVzaChcbiAgICAgICAgRGV0ZWN0Q2hhbmdlc1ZhcnMudmFsVW53cmFwcGVyLnNldChvLmltcG9ydEV4cHIoSWRlbnRpZmllcnMuVmFsdWVVbndyYXBwZXIpLmluc3RhbnRpYXRlKFtdKSlcbiAgICAgICAgICAgIC50b0RlY2xTdG10KG51bGwsIFtvLlN0bXRNb2RpZmllci5GaW5hbF0pKTtcbiAgfVxuICByZXR1cm4gdmFyU3RtdHMuY29uY2F0KHN0bXRzKTtcbn1cblxuZnVuY3Rpb24gYWRkUmV0dXJuVmFsdWVmTm90RW1wdHkoc3RhdGVtZW50czogby5TdGF0ZW1lbnRbXSwgdmFsdWU6IG8uRXhwcmVzc2lvbik6IG8uU3RhdGVtZW50W10ge1xuICBpZiAoc3RhdGVtZW50cy5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHN0YXRlbWVudHMuY29uY2F0KFtuZXcgby5SZXR1cm5TdGF0ZW1lbnQodmFsdWUpXSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHN0YXRlbWVudHM7XG4gIH1cbn1cblxuZnVuY3Rpb24gZ2V0Q29udGV4dFR5cGUodmlldzogQ29tcGlsZVZpZXcpOiBvLlR5cGUge1xuICB2YXIgdHlwZU1ldGEgPSB2aWV3LmNvbXBvbmVudC50eXBlO1xuICByZXR1cm4gdHlwZU1ldGEuaXNIb3N0ID8gby5EWU5BTUlDX1RZUEUgOiBvLmltcG9ydFR5cGUodHlwZU1ldGEpO1xufVxuXG5mdW5jdGlvbiBnZXRDaGFuZ2VEZXRlY3Rpb25Nb2RlKHZpZXc6IENvbXBpbGVWaWV3KTogQ2hhbmdlRGV0ZWN0aW9uU3RyYXRlZ3kge1xuICB2YXIgbW9kZTogQ2hhbmdlRGV0ZWN0aW9uU3RyYXRlZ3k7XG4gIGlmICh2aWV3LnZpZXdUeXBlID09PSBWaWV3VHlwZS5DT01QT05FTlQpIHtcbiAgICBtb2RlID0gaXNEZWZhdWx0Q2hhbmdlRGV0ZWN0aW9uU3RyYXRlZ3kodmlldy5jb21wb25lbnQuY2hhbmdlRGV0ZWN0aW9uKSA/XG4gICAgICAgICAgICAgICBDaGFuZ2VEZXRlY3Rpb25TdHJhdGVneS5DaGVja0Fsd2F5cyA6XG4gICAgICAgICAgICAgICBDaGFuZ2VEZXRlY3Rpb25TdHJhdGVneS5DaGVja09uY2U7XG4gIH0gZWxzZSB7XG4gICAgbW9kZSA9IENoYW5nZURldGVjdGlvblN0cmF0ZWd5LkNoZWNrQWx3YXlzO1xuICB9XG4gIHJldHVybiBtb2RlO1xufSJdfQ==