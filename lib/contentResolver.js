var fs    = require('fs'),
    path  = require('path'),
    utils = require('./utils'),
    coffeeScript = require('coffee-script'),
    invalidKeyTest = /\W/,

    searchPaths = null,
    modulePaths = null,
    compressJS = false,
    contentMetaCache = {};

function Content(pathPart, name, ext, type) {
  this.ext = ext;
  if(pathPart !== undefined) {
    this.meta = getContentMeta(pathPart, name, ext, type);
    this.setContent(readContentSync(this.meta), type);
  }
}
var proto = Content.prototype;

proto.getDiskPath = function getDiskPath() {
  return this.meta.mainFile;
};

proto.setContent = function setContent(newContent, type, skipMangle) {
  this.content = this.contentRaw = newContent;
  if(this.ext === 'coffee') {
    try {
      this.content = this.contentRaw = coffeeScript.compile(newContent.toString('utf8'));
    } catch (e) {
      console.error("Error compiling file '" + this.meta.mainFile + ":" + e.message);
    }
  }
  if(compressJS && type === 'js') {
    this.contentRaw = this.content.toString('utf8');
    try {
      this.content = utils.compressJS(this.content.toString('utf8'), skipMangle);
    } catch (e) {
      console.error("Error compressing file '" + this.meta.mainFile + ":" + e.message);
      this.content = this.contentRaw;
    }
  }
};

proto.getContent = function getContent(encoding) {
  if(encoding) {
    return this.content.toString(encoding);
  }
  return this.content;
};
proto.getContentRaw = function getContentRaw(encoding) {
  if(encoding) {
    return this.contentRaw.toString(encoding);
  }
  return this.contentRaw;
};


/**
 * Export the factory function for creating new Content objects
 */
module.exports = function(paths, mPaths, doCompress) {
  searchPaths = paths || [];
  modulePaths = mPaths;

  compressJS = doCompress || false;

  return function ContentFactory(pathPart, name, ext, type) {
    return new Content(pathPart, name, ext, type);
  };
};

function endsWith(str, suffix) { // Source: http://stackoverflow.com/a/2548133
    return str.indexOf(suffix, str.length - suffix.length) !== -1;
}

function readAndProcessAssemblyPartSync(filePath) {
  var content = fs.readFileSync(filePath).toString('utf8');

  if (endsWith(filePath, ".coffee")) {
    content = coffeeScript.compile(content, {bare: true, header: true});
  }

  return content;
}

/**
 * Helper functions
 */
function readContentSync(meta, isSubAssembly) {
  var contents = fs.readFileSync(meta.mainFile);
  if(meta.assembled) {
    try {
      var assembly = JSON.parse(contents);
      var hasTranslations = false;
      var filePath, i, j, translations;
      var template, filesLength, assembliesLength, errorStr;
      var localeFileName, localePath, templatePath;
      var baseTemplatePath, baseTemplatePathExists;
      var baseLocalePath, baseLocalePathExists, enFilePath;
      var assembly_resolution_paths = searchPaths;

      templatePath     = (assembly.templatePath || "templates");
      localePath       = (assembly.localePath || "locales");
      localeFileName   = (assembly.localeFileName || meta.name);
      filesLength      = (assembly.files      || []).length;
      assembliesLength = (assembly.assemblies || []).length;
      baseTemplatePath = path.join(meta.baseModulePath, templatePath);
      baseTemplatePathExists = fs.existsSync(baseTemplatePath);
      baseLocalePath   = path.join(meta.baseModulePath, localePath);
      baseLocalePathExists = fs.existsSync(baseLocalePath);

      errorStr = "";
      if (assembly.templatePath && !baseTemplatePathExists) {
        errorStr += "\n'templatePath' was defined as '"+assembly.templatePath+"' but the path does not exist.";
      }

      if (assembly.localePath || assembly.localeFileName) {
        if (assembly.localePath && !baseLocalePathExists) {
          errorStr += "\n'localePath' was defined as '"+assembly.localePath+"' but the path does not exist.";
        }

        if (assembly.localeFileName) {
          enFilePath = path.join(baseLocalePath, localeFileName + "_en.json");
          hasTranslations = fs.existsSync(enFilePath);
          if (!hasTranslations) {
            errorStr += "\n'localeFileName' was defined as '"+assembly.localeFileName+"' but the file '"+localePath+"/"+assembly.localeFileName+"_en.json' does not exist.";
          }
        }
      }

      if (errorStr) {
        throw new Error(errorStr);
      }

      // If the default locale path does not exist, then check up one folder.
      if(!baseLocalePathExists) {
        baseLocalePath = path.join(meta.basePath, "../locales", meta.pathPart);
        baseLocalePathExists = fs.existsSync(baseLocalePath);
      }

      if(baseLocalePathExists) {
        enFilePath = path.join(baseLocalePath, localeFileName + "_en.json");
        hasTranslations = fs.existsSync(enFilePath);
      }

      if (filesLength || assembliesLength) {
        if (isSubAssembly) {
          if (assembly.simpleWrap !== true) {
            throw new Error("Sub assemblies MUST have 'simpleWrap' set to true.");
          }
          contents = "//Module sub-assembly: " + meta.name + "\n\n";
        }
        else {
          contents = "//Module assembly: " + meta.name + "\n\n";
        }
      }

      if (filesLength > 0) {
        if(assembly.simpleWrap) {
          contents += "(function(window,undefined){\n";
        } else if(assembly.prefix) {
          contents += assembly.prefix + '\n\n';
        }

        for(i=0; i<filesLength; ++i) {
          filePath = path.join(meta.baseModulePath, assembly.files[i]);
          if (!fs.existsSync(filePath)) {
            for (j = 0; j < assembly_resolution_paths.length; j++) {
              filePath = path.join(assembly_resolution_paths[j] + "/js/", assembly.files[i]);
              if (fs.existsSync(filePath)) {
                break;
              }
            }
          }
          if (fs.existsSync(filePath)) {
            contents = appendContents(contents, readAndProcessAssemblyPartSync(filePath), assembly.files[i]);
          }
          else {
            contents += "/*\n * Included File: "+assembly.files[i]+"\n*/\n\nconsole.error(\"Asset Manager build error:\\nFile '"+assembly.files[i]+"' was not found and could not be included.\");\n\n";
          }
        }

        //append any translations
        if(hasTranslations) {
          translations = utils.readLocaleFiles(baseLocalePath, localeFileName);
          contents = appendContents(contents, "var langs = " + JSON.stringify(translations) + ";", localeFileName + "_en" + ".json");
          contents = appendContents(contents, "var locale = FS.locale || window.locale || 'en';" +
                                              "locale = typeof(locale) == 'string' ? locale : locale[0].split('-')[0];" +
                                              "var l1 = langs[locale] || langs['en'];" +
                                              "var lang = $.extend({}, langs['en'], l1);", "Injected code");
        }

        //append the html template
        filePath = path.join(meta.baseModulePath, "template.html");
        if(fs.existsSync(filePath)) {
          template = fs.readFileSync(filePath).toString('utf8');
          if (template) {
            template = utils.convertHTMLtoJS(template, hasTranslations);

            contents = appendContents(contents, template, 'template.html');
          }
        }

        // Create the variable templateList and all of it's sub-properties based on the files listed in the templates folder
        var templatesStr = "";
        if (baseTemplatePathExists) {
          var fileList = fs.readdirSync(baseTemplatePath).sort();
          // !IMPORTANT. MGC - 06-16-2014 ".sort()" protects againt test failure even if the template files load in a different order.
          contents += "  var templateList = {};\n\n";

          fileList.forEach(function(fileName){
            if (path.extname(fileName).toLowerCase() === ".html") {
              // Only load .html files as templates
              var str = getTemplateAsString(path.join(baseTemplatePath, fileName)) || "";
              var templateKey = fileName.slice(0,-5); // Get the filename without the .html to use as the key

              if(invalidKeyTest.test(templateKey)){
                throw new Error("Template file names can only use _ or alphanumeric characters.")
              }

              templatesStr = "  templateList."+templateKey+" = "+str+";";
              contents = appendContents(contents, templatesStr, templatePath+'/'+fileName);
            }
          });

          contents += '  function getTemplateStr(key) {';
          if (hasTranslations) {
            contents += '\n    return (templateList[key]||"").format(lang);\n  }';
          } else {
            contents += '\n    return templateList[key]||"";\n  }';
          }
          contents += '\n\n  function getTemplate(key) {\n    var snip = document.createElement("div");';
          contents += '\n    $(snip).html(getTemplateStr(key));';
          contents += '\n    return snip;\n  }\n';
        }

        if(assembly.simpleWrap) {
          contents += "}(window));";
        } else if(assembly.suffix) {
          contents += assembly.suffix;
        }
      }
      else {
        contents += "// No files in this assembly.";
      }

      // Load the sub-assemblies
      for(i=0; i<assembliesLength; ++i) {
        var subName = assembly.assemblies[i];
        var subBasePath = path.join(meta.baseModulePath, subName);
        filePath = path.join(subBasePath, "assembly.json");
        if (fs.existsSync(filePath)) {
          var subPathPart = meta.pathPart+meta.name+"/"
          var subMeta = {
            "assembled": true,
            "mainFile": filePath,
            "name": subName,
            "pathPart": subPathPart,
            "baseModulePath": subBasePath,
            "basePath": meta.basePath
          };

          contents += "\n\n"+readContentSync(subMeta, true)+"\n\n";
        }
        else {
          contents += "\n\n//Module sub-assembly: "+subName+"\nconsole.error(\"Asset Manager build error:\\nSub-assembly '"+subName+"' was not found and could not be included.\");\n\n";
        }
      }
    } catch (e) {
      var error = "Failed to build assembly '" + meta.name + "/assembly.json'.\n" + e.message;
      contents = "\nconsole.error(\"Asset Manager build error:\\n" + (error.replace(/"/g, "\\\"").replace(/\n+/g, " - ")) + "\");";
      console.error(error);
    }
  }

  return contents;
}

function getTemplateAsString(fileName) {
  var content = "";
  if (fs.existsSync(fileName)) {
    var html = fs.readFileSync(fileName, 'utf8');
    content = flattenHtml(html);
  }

  return content;
}

function flattenHtml(html) {
  html = html.replace(/(\r*\n)+/g, "\n");
  html = html.replace(/"/g, "\\\"");
  var lines = html.split("\n");
  var text = "";

  for(var i=0; i<lines.length; ++i){
    var line = lines[i];
    if(line) {
      if (text) {
        text += "+\n";
      }
      text += "\"" + line + "\\n\"";
    }
  }

  return text;
}

function appendContents(contents, newContents, fileName) {
  contents += "/*\n * Included File: " + fileName + "\n */\n\n" + newContents + "\n\n";
  return contents;
}

/**
 * Checks filesystem to see if the asset exists in one of our asset paths,
 * caches the absolute path of the resource, and returns the fullPath if it exists
 * otherwise, it returns null if the path can't be found.
 */
function getContentMeta(pathPart, name, ext, type) {
  var checkPath = path.join(type, pathPart, name + "." + ext),
      indexPath = path.join(type, pathPart, name, "index." + ext),
      assemblyPath = path.join(type, pathPart, name, "assembly.json"),
      moduleCSSPath = path.join('js', pathPart, name, name + ".css"),
      moduleHTMLPath = path.join('js', pathPart, name, name + ".html"),
      finalPaths = searchPaths;

  if(modulePaths && (type === 'css' || type === 'img' || type === 'html')) {
    finalPaths = finalPaths.concat(modulePaths);
  }

  //return from cache if found
  if(contentMetaCache[checkPath]){
    return contentMetaCache[checkPath];
  }

  //try and resolve in searchPaths
  var meta = {
    assembled: false,
    mainFile: null,
    name: name,
    pathPart: pathPart
  };

  for(var i=0; i<finalPaths.length; ++i){
    var fullPath = path.resolve(finalPaths[i], checkPath);
    //look for exact path match
    if(fs.existsSync(fullPath)) {
      meta.mainFile = fullPath;
      break;
    }

    //look for a folder with an index file in it
    fullPath = path.resolve(finalPaths[i], indexPath);
    //look for exact path match
    if(fs.existsSync(fullPath)) {
      meta.mainFile = fullPath;
      break;
    }

    if(type === 'css') {
      //look for a module with this css file in it
      fullPath = path.resolve(finalPaths[i], moduleCSSPath);
      //look for exact path match
      if(fs.existsSync(fullPath)) {
        meta.mainFile = fullPath;
        break;
      }
    }
    if(type === 'html') {
      //look for a module with this html file in it
      fullPath = path.resolve(finalPaths[i], moduleHTMLPath);
      //look for exact path match
      if(fs.existsSync(fullPath)) {
        meta.mainFile = fullPath;
        break;
      }
    }

    //look for a folder with an assemblies.json file in it
    fullPath = path.resolve(finalPaths[i], assemblyPath);
    //look for exact path match
    if(fs.existsSync(fullPath)) {
      meta.mainFile = fullPath;
      meta.assembled = true;
      meta.baseModulePath = path.join(finalPaths[i], type, pathPart, name);
      meta.basePath = finalPaths[i];
      break;
    }
  }

  if(meta.mainFile === null) {
    throw new Error("Unrecognized asset: " + checkPath);
  } else {
    contentMetaCache[checkPath] = meta;
  }
  return meta;
}
