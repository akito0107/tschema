import * as ts from "typescript";
import { JSONSchema7 } from "json-schema";

const testfile = "testdata/simple.ts";

const program = ts.createProgram({
  rootNames: [testfile],
  options: {
    noEmit: true
  }
});

const typeChecker = program.getTypeChecker();

const resolved: { [key: string]: JSONSchema7 } = {};
const decls: { [key: string]: ts.TypeNode } = {};
const metaTypes: { [key: string]: ts.Node } = {};

function scan(n: ts.Node) {
  if (ts.isTypeAliasDeclaration(n)) {
    if (n.typeParameters) {
      metaTypes[n.name.text] = n;
    } else {
      decls[n.name.text] = n.type;
    }
  } else {
    n.forEachChild(node => scan(node));
  }
}

function resolve(name: string): JSONSchema7 {
  if (resolved[name]) {
    return resolved[name];
  }
  if (decls[name]) {
    resolved[name] = getTypeDefinition(decls[name]);
    return resolved[name];
  }
  throw new Error(`"${name}" not found`);
}

function getTypeDefinition(t: ts.TypeNode): JSONSchema7 {
  const jsdocTag = {};
  if (t.parent) {
    ts.getJSDocTags(t.parent).forEach(tag => {
      jsdocTag[tag.tagName.text] = tag.comment;
    });
  }
  switch (t.kind) {
    case ts.SyntaxKind.StringKeyword:
      return {
        type: "string",
        ...jsdocTag
      };
    case ts.SyntaxKind.NumberKeyword:
      return {
        type: "number",
        ...jsdocTag
      };
    case ts.SyntaxKind.BooleanKeyword:
      return {
        type: "boolean",
        ...jsdocTag
      };
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
      return {
        type: "null",
        ...jsdocTag
      };
  }
  if (ts.isTypeLiteralNode(t)) {
    const signatures = t.members.filter(ts.isPropertySignature);
    const properties = signatures.reduce(
      (acc, x) => {
        return {
          ...acc,
          [x.name.getText()]: getTypeDefinition(x.type)
        };
      },
      {} as {
        [key: string]: JSONSchema7;
      }
    );
    const required = signatures
      .filter(s => s.questionToken == null)
      .map(s => s.name.getText());
    return {
      type: "object",
      properties,
      required,
      ...jsdocTag
    };
  }
  if (ts.isArrayTypeNode(t)) {
    return {
      type: "array",
      items: getTypeDefinition(t.elementType),
      ...jsdocTag
    };
  }
  if (ts.isTypeReferenceNode(t)) {
    switch (t.typeName.getText()) {
      case "Array":
        return {
          type: "array",
          items: getTypeDefinition(t.typeArguments[0]),
          ...jsdocTag
        };
      case "Partial":
        const partialDef = getTypeDefinition(t.typeArguments[0]);
        delete partialDef.required;
        return {
          ...partialDef,
          ...jsdocTag
        };
      case "Required":
        const requiredDef = getTypeDefinition(t.typeArguments[0]);
        requiredDef.required = Object.keys(requiredDef.properties);
        return {
          ...requiredDef,
          ...jsdocTag
        };
      case "Readonly":
        return {
          ...getTypeDefinition(t.typeArguments[0]),
          ...jsdocTag
        };
      case "Pick":
        const pickDef = getTypeDefinition(t.typeArguments[0]);
        const pickKeys = getTypeDefinition(t.typeArguments[1]);
        return {
          ...pickProperties(pickDef, pickKeys.enum as string[]),
          ...jsdocTag
        };
      case "Record":
        const recordKeys = getTypeDefinition(t.typeArguments[0])
          .enum as string[];
        const recordType = getTypeDefinition(t.typeArguments[1]);
        const properties = {};
        recordKeys.forEach(k => {
          properties[k] = {
            ...recordType
          };
        });
        return {
          type: "object",
          properties,
          required: recordKeys,
          ...jsdocTag
        };
      case "Exclude":
        return {
          ...getTypeDefinition(t.typeArguments[0]),
          ...jsdocTag
        };
      case "Extract":
        return {
          ...getTypeDefinition(t.typeArguments[1]),
          ...jsdocTag
        };
      case "Omit":
        const omitDef = getTypeDefinition(t.typeArguments[0]);
        const omitKeys = getTypeDefinition(t.typeArguments[1]);
        return {
          ...dropProperties(omitDef, omitKeys.enum as string[]),
          ...jsdocTag
        };
      case "Date":
        return {
          type: "string",
          format: "time",
          ...jsdocTag
        };
      case "RegExp":
        return {
          type: "string",
          format: "regex",
          ...jsdocTag
        };
      default:
        if (t.typeArguments == null) {
          return {
            ...resolve(t.typeName.getText()),
            ...jsdocTag
          };
        } else {
        }
    }
  }
  if (ts.isLiteralTypeNode(t)) {
    if (ts.isStringLiteral(t.literal)) {
      return {
        enum: [t.literal.text],
        ...jsdocTag
      };
    }
    if (ts.isNumericLiteral(t.literal)) {
      return {
        enum: [+t.literal.text],
        ...jsdocTag
      };
    }
  }
  if (ts.isUnionTypeNode(t)) {
    const literals = t.types.filter(ts.isLiteralTypeNode).map(l => l.literal);
    if (literals.length === t.types.length) {
      const strings = literals.filter(ts.isStringLiteral);
      if (literals.length === strings.length) {
        return {
          enum: strings.map(s => s.text),
          ...jsdocTag
        };
      }
      const numbers = literals.filter(ts.isNumericLiteral);
      if (literals.length === numbers.length) {
        return {
          enum: numbers.map(n => +n.text),
          ...jsdocTag
        };
      }
    }
    return {
      oneOf: t.types.map(getTypeDefinition),
      ...jsdocTag
    };
  }
  if (ts.isIntersectionTypeNode(t)) {
    return {
      allOf: t.types.map(getTypeDefinition),
      ...jsdocTag
    };
  }
  if (ts.isTypeOperatorNode(t)) {
    switch (t.operator) {
      case ts.SyntaxKind.KeyOfKeyword:
        const arg = getTypeDefinition(t.type);
        return {
          enum: Object.keys(arg.properties),
          ...jsdocTag
        };
    }
  }
  if (ts.isConditionalTypeNode(t)) {
    const resolvedType = typeChecker.getTypeFromTypeNode(t);
    const trueType = typeChecker.getTypeFromTypeNode(t.trueType);
    const falseType = typeChecker.getTypeFromTypeNode(t.falseType);
    if (isSameType(trueType, falseType)) {
      throw new Error(`bad conditional type, trueType equals falseType`); // TODO: add more information
    }
    if (isSameType(resolvedType, trueType)) {
      return {
        ...getTypeDefinition(t.trueType),
        ...jsdocTag
      };
    } else {
      return {
        ...getTypeDefinition(t.falseType),
        ...jsdocTag
      };
    }
  }
  console.log(t);
  throw new Error("unsupported node");
}

function isSameType(a: ts.Type, b: ts.Type): boolean {
  if (a.flags !== b.flags) {
    return false;
  }
  return typeChecker.typeToString(a) === typeChecker.typeToString(b);
}

function pickProperties(def: JSONSchema7, keys: string[]): JSONSchema7 {
  if (def.type === "object") {
    const properties = {};
    keys.forEach(p => {
      properties[p] = def.properties[p];
    });
    return {
      ...def,
      properties,
      required: def.required.filter(x => keys.includes(x))
    };
  }
  if (def.allOf) {
    return {
      ...def,
      allOf: def.allOf.map(x => pickProperties(x as JSONSchema7, keys))
    };
  }
  if (def.oneOf) {
    return {
      ...def,
      allOf: def.oneOf.map(x => pickProperties(x as JSONSchema7, keys))
    };
  }
  if (def.anyOf) {
    return {
      ...def,
      allOf: def.anyOf.map(x => pickProperties(x as JSONSchema7, keys))
    };
  }
}

function dropProperties(def: JSONSchema7, keys: string[]): JSONSchema7 {
  if (def.type === "object") {
    keys.forEach(p => {
      delete def.properties[p];
    });
    return {
      ...def,
      required: def.required.filter(x => !keys.includes(x))
    };
  }
  if (def.allOf) {
    return {
      ...def,
      allOf: def.allOf.map(x => dropProperties(x as JSONSchema7, keys))
    };
  }
  if (def.oneOf) {
    return {
      ...def,
      allOf: def.oneOf.map(x => dropProperties(x as JSONSchema7, keys))
    };
  }
  if (def.anyOf) {
    return {
      ...def,
      allOf: def.anyOf.map(x => dropProperties(x as JSONSchema7, keys))
    };
  }
}

const rootNode = program.getSourceFile(testfile);
scan(rootNode);
Object.keys(decls).forEach(k => {
  console.log(k);
  console.log(JSON.stringify(resolve(k), null, 2));
});
