import { Engine, FilterSet, uBlockResources } from 'adblock-rs'

import path from 'path'
import { promises as fs } from 'fs'

const uBlockLocalRoot = 'submodules/uBlock'
const uBlockWebAccessibleResources = path.join(uBlockLocalRoot, 'src/web_accessible_resources')
const uBlockRedirectEngine = path.join(uBlockLocalRoot, 'src/js/redirect-resources.js')
const uBlockScriptlets = path.join(uBlockLocalRoot, 'assets/resources/scriptlets.js')

const braveResourcesUrl = 'https://raw.githubusercontent.com/deepakdahiya/adblock-resources/master/dist/resources.json'

const listCatalogUrl = 'https://raw.githubusercontent.com/deepakdahiya/adblock-resources/master/filter_lists/list_catalog.json'

const regionalCatalogComponentId = 'bbhodghhfoljambigkiibfnmgkobming'
const regionalCatalogPubkey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAteLpEXUrGmrqoP0zVdrrG6ryZX4zuM6uKMSFjTFwGYD3BmqKPZis65HABWe1dSVE96YojLBG+uGK9McNwHb7pC+Ht3L9TRF4qY/vLLHFSb1lBzgNo+IVOC+s7cj0tQ5CquKd4I14xJTAlHovsI6ytki4N89is2wFGuJCv+zY6Y8fBmseykhlcp3EHHNX3iKaQMX5B66omEw57iAHMXcBxNzQEcssBcPnej3FlaPojgdtg+Fzb55OpRgYCq/N5VP8oKGG2LZAxW8rjyab4wVpI5cNRpVJZzdDhRdkIU05TpIiC0drDprKvNdUpumTVxTtzeOfWjXQPqW7iTSX6HJPUwIDAQAB'

const resourcesComponentId = 'dlibbfbdhhamaleoofdjnejelcgldodb'
const resourcesPubkey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlYa/Beo8ErS7GB31gsjHQOerBEGD58eXXf6GLPxp8cyJ/DFF06Svo8uXEZMuFK6pT6Qi1byX5UVjNmeB5Xwb6TndxJGQAYPL2YA8R60OpKDL8fKRmikI6vBleV1Fw56qYi/SoT47xqxf/F7uOFmsW6768ImB9lyF6YWW5ZpUDaHj1H5XemUWSF3JzY6uBYEkjdn1KmbE+zz+tNh1UXrdAkWSXr3opGDFNWKEg9kOBa2gEZh42mwNJDS8Olo8RgrKQbSHr5zxMCuxsntdua22mH4vBzHoauLRwQqYpLW64Kkl5xx0cDizUF7EGbqhB+Xcm4yD5kvNzmDzQ6WdNMRLkwIDAQAB'

/**
 * Returns a promise that which resolves with the body parsed as JSON
 *
 * @param url The URL to fetch from
 * @return a promise that resolves with the content of the list or rejects with an error message.
 */
const requestJSON = (url) => {
  return fetch(url).then(response => {
    if (response.status !== 200) {
      throw new Error(`Error status ${response.status} ${response.statusText} returned for URL: ${url}`)
    }
    return response.json()
  }).catch(error => {
    throw new Error(`Error when fetching ${url}: ${error.message}`)
  })
}

const lazyInit = (fn) => {
  let prom
  return () => {
    prom = prom || fn()
    return prom
  }
}

const getListCatalog = lazyInit(async () => {
  return requestJSON(listCatalogUrl)
})

// Legacy logic requires a distinction between default and regional lists.
// This can be removed once DAT support is no longer needed by iOS.
const isDefaultList = entry => entry.default_enabled && entry.hidden
const getDefaultLists = () => getListCatalog().then(catalog => {
  return catalog.filter(isDefaultList)
})
const getRegionalLists = () => getListCatalog().then(catalog => {
  return catalog.filter(entry => !isDefaultList(entry))
})

// Wraps new template scriptlets with the older "numbered template arg" format and any required dependency code
const wrapScriptletArgFormat = (fnString, dependencyPrelude) => `{
  const args = ["{{1}}", "{{2}}", "{{3}}", "{{4}}", "{{5}}", "{{6}}", "{{7}}", "{{8}}", "{{9}}"];
  let last_arg_index = 0;
  for (const arg_index in args) {
    if (args[arg_index] === '{{' + (Number(arg_index) + 1) + '}}') {
      break;
    }
    last_arg_index += 1;
  }
  ${dependencyPrelude}
  (${fnString})(...args.slice(0, last_arg_index))
}`

const generateResources = lazyInit(async () => {
  const { builtinScriptlets } = await import(path.join('..', uBlockScriptlets).toString())

  const dependencyMap = builtinScriptlets.reduce((map, entry) => {
    map[entry.name] = entry
    return map
  }, {})

  const transformedUboBuiltins = builtinScriptlets.filter(s => !s.name.endsWith('.fn')).map(s => {
    // Bundle dependencies wherever needed. This causes some small duplication but makes each scriptlet fully self-contained.
    let dependencyPrelude = ''
    const requiredDependencies = s.dependencies ?? []
    for (const dep of requiredDependencies) {
      for (const recursiveDep of dependencyMap[dep].dependencies ?? []) {
        if (!requiredDependencies.includes(recursiveDep)) {
          requiredDependencies.push(recursiveDep)
        }
      }
    }
    for (const dep of requiredDependencies.reverse()) {
      const thisDepCode = dependencyMap[dep].fn.toString()
      if (thisDepCode === undefined) {
        throw new Error(`Couldn't find dependency ${dep}`)
      }
      dependencyPrelude += thisDepCode + '\n'
    }
    const content = Buffer.from(wrapScriptletArgFormat(s.fn.toString(), dependencyPrelude)).toString('base64')
    // in Brave Browser, bit 0 (i.e. 1 << 0) signifies uBO resource permission.
    return {
      name: s.name,
      aliases: s.aliases ?? [],
      kind: { mime: 'application/javascript' },
      content
    }
  })

  const resourceData = uBlockResources(
    uBlockWebAccessibleResources,
    uBlockRedirectEngine
  )

  const braveResources = await requestJSON(braveResourcesUrl)
  resourceData.push(...braveResources)
  resourceData.push(...transformedUboBuiltins)
  return JSON.stringify(resourceData)
})

/**
 * Returns a promise that generates a resources file from the uBlock Origin
 * repo hosted on GitHub
 */
const generateResourcesFile = async (outLocation) => {
  return fs.writeFile(outLocation, await generateResources(), 'utf8')
}

/**
 * A list of requests that should not be blocked unless the list has some serious issue.
 *
 * Each element is [requestUrl, sourceUrl, requestType].
 */
const sampleUnblockedNetworkRequests = [
  // real resources from a personal website which will never ship ads/trackers
  ['https://antonok.com', 'https://antonok.com', 'document'],
  ['https://antonok.com/style.css?h=9aba43f4dd864e1e4f3a', 'https://antonok.com', 'stylesheet'],
  ['https://antonok.com/res/font/icons.woff2?h=598bc5b2aa7cdaf390d9', 'https://antonok.com', 'font'],
  ['https://antonok.com/res/antonok-logo.svg', 'https://antonok.com', 'image'],
  ['https://antonok.com/processed_images/profile-2021-05-03.14f955fe3ab1a230.webp', 'https://antonok.com', 'image'],
  // real resources from brave.com
  ['https://brave.com', 'https://brave.com', 'document'],
  ['https://brave.com/js/navigation.js', 'https://brave.com', 'script'],
  ['https://brave.com/static-assets/css-old/main.min.css', 'https://brave.com', 'stylesheet'],
  ['https://brave.com/static-assets/images/brave-logo-sans-text.svg', 'https://brave.com', 'image'],
  // real resources from Brave's QA testing pages
  ['https://dev-pages.brave.software/filtering/index.html', 'https://dev-pages.brave.software/filtering/index.html', 'document'],
  ['https://dev-pages.brave.software/static/css/bootstrap.min.css', 'https://dev-pages.brave.software/filtering/index.html', 'stylesheet'],
  ['https://dev-pages.brave.software/static/css/site.css', 'https://dev-pages.brave.software/filtering/index.html', 'stylesheet'],
  ['https://dev-pages.brave.software/static/js/site.js', 'https://dev-pages.brave.software/filtering/index.html', 'script'],
  ['https://dev-pages.bravesoftware.com/filtering/index.html', 'https://dev-pages.bravesoftware.com/filtering/index.html', 'document'],
  ['https://dev-pages.bravesoftware.com/static/images/test.jpg', 'https://dev-pages.bravesoftware.com/filtering/additional-lists.html', 'image'],
  // real resources from wikipedia.org
  ['https://en.wikipedia.org/wiki/Ad_blocking', 'https://en.wikipedia.org/wiki/Ad_blocking', 'document'],
  ['https://en.wikipedia.org/w/load.php?lang=en&modules=codex-search-styles%7Cext.cite.styles%7Cext.pygments%2CwikimediaBadges%7Cext.uls.interlanguage%7Cext.visualEditor.desktopArticleTarget.noscript%7Cskins.vector.icons%2Cstyles%7Cskins.vector.zebra.styles%7Cwikibase.client.init&only=styles&skin=vector-2022', 'https://en.wikipedia.org/wiki/Ad_blocking', 'stylesheet'],
  ['https://en.wikipedia.org/w/load.php?lang=en&modules=startup&only=scripts&raw=1&skin=vector-202', 'https://en.wikipedia.org/wiki/Ad_blocking', 'script'],
  ['https://en.wikipedia.org/static/images/mobile/copyright/wikipedia-wordmark-en.svg', 'https://en.wikipedia.org/wiki/Ad_blocking', 'image'],
  ['https://en.wikipedia.org/static/images/icons/wikipedia.png', 'https://en.wikipedia.org/wiki/Ad_blocking', 'image'],
  // hypothetical embeddings on example.com
  ['https://antonok.com', 'https://example.com', 'subdocument'],
  ['https://brave.com', 'https://example.com', 'subdocument'],
  ['https://en.wikipedia.org/wiki/Ad_blocking', 'https://example.com', 'subdocument']
]

/*
 * Throw an error if the list is blocking any of the resources from `sampleNetworkRequests`.
 */
const sanityCheckList = ({ title, format, data }) => {
  const filterSet = new FilterSet()
  filterSet.addFilters(data.split('\n'), { format })
  const engine = new Engine(filterSet)
  for (const request of sampleUnblockedNetworkRequests) {
    const result = engine.check(request[0], request[1], request[2])
    if (result) {
      throw new Error(title + ' failed sanity check for ' + request + '. Check for corrupted list contents.')
    }
  }
}

export {
  regionalCatalogComponentId,
  regionalCatalogPubkey,
  resourcesComponentId,
  resourcesPubkey,
  sanityCheckList,
  generateResourcesFile,
  getListCatalog,
  getDefaultLists,
  getRegionalLists
}
