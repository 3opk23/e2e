const debug = require('debug')('dsc-e2e:lib:run-test')
const chrome = require('selenium-webdriver/chrome')
const { Builder } = require('selenium-webdriver')
const assert = require('assert')

require('./selenium-webdriver-fix')
const {
  createSauceLabName,
  updateSauceJob,
  SAUCE_USERNAME,
  SAUCE_ACCESS_KEY,
} = require('./saucelabs')
const {
  createTimeoutError,
  toMS,
  sleep,
  getElapsedTime,
  isPromise,
} = require('./utils')

module.exports = class RunTest {
  constructor (context, attempt) {
    this.context = context
    this.attempt = attempt
    this.results = []
    this.steps = []

    this.step = this._step()
  }

  // returns the output of the test
  async exec () {
    const { context, results } = this
    const start = process.hrtime()

    await this.runTest()

    return {
      context,
      results,
      success: results.every(result => result.success),
      elapsedTime: getElapsedTime(start),
    }
  }

  // runs the test
  async runTest () {
    const { context, steps } = this

    if (await this.createDriver() !== false) {
      // initialize the test
      const result = context.test.test(this, context)
      assert(!isPromise(result), 'Test functions should not be async!')

      // run the test steps
      for (const step of steps) {
        const r = await this.runStep(step)
        if (r === false) break
      }
    }

    await this.quitDriver()
    await this.updateSauceLabs()

    debug(this.results)
  }

  // create the driver based on our 3 modes
  async createDriver () {
    const { context } = this
    const {
      mode,
      test: {
        options: {
          client,
        },
      },
    } = context

    if (mode === 'sauce') {
      let sauceName
      let driver

      const s0 = await this.runStep({
        name: 'setup Sauce Labs driver',
        fn: async () => {
          sauceName = createSauceLabName(context.test.id, context.env) // TODO: check
          assert.equal(typeof sauceName, 'string')
          const capabilities = {
            name: sauceName,
            browserName: client.browser.name,
            platform: client.platform.name,
            version: 'latest',
            screenResolution: `${client.platform.width}x${client.platform.height}`,
            username: SAUCE_USERNAME,
            accessKey: SAUCE_ACCESS_KEY,
          }
          debug('capabilities: %o', capabilities)
          driver = this.driver = new Builder()
            .withCapabilities(capabilities)
            .usingServer(`https://${SAUCE_USERNAME}:${SAUCE_ACCESS_KEY}@ondemand.saucelabs.com/wd/hub`)
            .build()
        },
        timeout: toMS('90s'),
      })
      if (s0 === false) return false

      const s1 = await this.runStep({
        name: 'get Sauce Labs session',
        fn: async () => {
          const session = await driver.getSession()

          context.sauce = {
            name: sauceName,
            session_id: session.id_,
          }
        },
        timeout: toMS('30s'),
      })
      if (s1 === false) return false
      return
    }

    let builder
    const s0 = await this.runStep({
      name: 'setup Chrome builder',
      fn: async () => {
        builder = await new Builder().forBrowser(client.browser.name)
      },
      timeout: toMS('90s'),
    })
    if (s0 === false) return false

    if (client.browser.name === 'chrome' && mode === 'headless') {
      const s1 = await this.runStep({
        name: 'setup headless Chrome driver',
        fn: async () => {
          builder.setChromeOptions(new chrome.Options().addArguments(
            '--headless',
            '--disable-extensions',
            '--disable-gpu',
            `--window-size=${client.width}x${client.height}`
          ))
          this.driver = await builder.build()
        },
        timeout: toMS('30s'),
      })
      if (s1 === false) return false
      return
    }

    const s3 = await this.runStep({
      name: 'setup Chrome driver',
      fn: async () => {
        const driver = this.driver = await builder.build()
        await driver.manage().window().setSize(client.width, client.height)
      },
      timeout: toMS('30s'),
    })
    if (s3 === false) return false
  }

  // quits the driver if it exists
  quitDriver () {
    return this.runStep({
      name: 'quit the driver',
      fn: async () => {
        const { driver } = this
        if (!driver) return
        // don't fail the test if we fail to quit the driver
        try {
          debug('quiting driver')
          await driver.quit()
          debug('quit the driver')
        } catch (err2) {
          console.error('Experienced an error quitting the driver. Ignoring.')
          debug(err2.stack || err2)
        }
      },
      timeout: toMS('30s'),
    })
  }

  // updates the sauce labs status of this test
  async updateSauceLabs () {
    const { context, results } = this
    if (!context.sauce) return

    debug('setting sauce status based on results: %o', results)

    return this.runStep({
      name: 'update sauce labs',
      fn: async () => {
        await updateSauceJob(context.sauce.session_id, {
          passed: results.every(result => result.success),
        })
      },
      timeout: toMS('30s'),
    })
  }

  // runs a step
  async runStep ({ name, fn, skip, timeout }) {
    const { context, results } = this
    const key = `${context.test.id} "${name}"`
    debug(`${key} — starting`)

    const result = {
      name,
      skip: !!skip,
    }

    results.push(result)

    if (skip) return

    const start = process.hrtime()

    try {
      await Promise.race([
        fn(),
        this.createStepTimeoutPromise(name, timeout),
      ])
      result.success = true
    } catch (err) {
      debug(err)
      result.success = false
      result.error = err
      return false // SKIP
    } finally {
      // TODO: hrtime
      result.elapsedTime = getElapsedTime(start)
      debug(`${key} — finished`)
    }
  }

  // create the step function at RunTest initialization
  _step () {
    const step = (name, fn, _options) => {
      const options = typeof _options === 'number' || typeof _options === 'string'
        ? { timeout: _options }
        : _options || {}
      const timeout = options.timeout
        ? toMS(options.timeout)
        : toMS(this.context.test.options.stepTimeout)

      this.steps.push({
        name,
        fn,
        timeout,
      })
    }

    step.skip = (name, fn) => {
      this.steps.push({
        name,
        fn,
        skip: true,
      })
    }

    return step
  }

  createStepTimeoutPromise (name, timeout) {
    return sleep(timeout).then(() => {
      throw createTimeoutError(`Test "${this.context.test.id}" step "${name}" timed out!`)
    })
  }
}
