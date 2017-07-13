import React from 'react'
import { Provider } from 'react-redux'
import { createStore, applyMiddleware, compose, combineReducers } from 'redux'
import { browserHistory } from 'react-router'

import isPlainObject from 'is-plain-object'
import invariant from 'invariant'
import warning from 'warning'
import flatten from 'flatten'
import isFunction from 'lodash.isfunction'
import window from 'global/window'
import document from 'global/document'

import Plugin from './plugin'
import handleActions from './handleActions'
import location, { updateLocation } from './location'

const SEP = '/'

export function createIfox (Opts) {
  const { initialReducer, defaultHistory } = Opts

  return function ifox (hooks = {}, initialState = {}, history = defaultHistory) {
    const plugin = new Plugin()
    plugin.use(hooks)

    const app = {
      _models: [],
      _store: null,
      _router: null,
      _history: history,
      _plugin: plugin,
      _getProvider: null,

      use,
      router,
      model,
      start
    }
    return app

    function use (hooks) {
      plugin.use(hooks)
    }

    function model (model) {
      this._models.push(checkModel(model))
    }

    function router (router) {
      invariant(typeof router === 'function', 'app.router: router should be function')
      this._router = router
    }

    function injectModel (createReducer, onError, unlisteners, model) {
      model = checkModel(model)
      this._models.push(model)
      const store = this._store

      store.asyncReducers[model.namespace] = getReducer(model.reducers, model.state)
      store.replaceReducer(createReducer(store.asyncReducers))

      if (model.subscriptions) {
        unlisteners[model.namespace] = runSubscriptions(model.subscriptions, model, this, onError)
      }
    }

    function unModel (createReducer, reducers, _unlisteners, namespace) {
      const store = this._store

      delete store.asyncReducers[namespace]
      delete reducers[namespace]
      store.replaceReducer(createReducer(store.asyncReducers))
      store.dispatch({ type: '@@ifox/UPDATE' })

      if (_unlisteners[namespace]) {
        const { unlisteners, noneFunctionSubscriptions } = _unlisteners[namespace]
        warning(noneFunctionSubscriptions.length === 0,
          `app.unModel: subscription should return unlistener function, check these subscriptions ${noneFunctionSubscriptions.join(', ')}`
        )

        for (const unlistener of unlisteners) {
          unlistener()
        }

        delete _unlisteners[namespace]
      }

      this._models = this._models.filter(model => model.namespace !== namespace)
    }

    function start (container) {
      if (typeof container === 'string') {
        container = document.querySelector(container)
        invariant(container, `app.start: could not query selector: ${container}`)
      }

      invariant(!container || isHTMLElement(container), 'app.start: container should be HTMLElement')

      const onError = plugin.apply('onError', (err) => {
        throw new Error(err.stack || err)
      })

      const onErrorWrapper = (err) => {
        if (err) {
          if (typeof err === 'string') err = new Error(err)
          onError(err, app._store.dispatch)
        }
      }

      model.call(this, {
        namespace: '@@ifox',
        state: 0,
        reducers: {
          UPDATE (state) { return state + 1 }
        }
      })

      const reducers = { ...initialReducer }
      for (const model of this._models) {
        reducers[model.namespace] = getReducer(model.reducers, model.state)
      }

      const extraReducers = plugin.get('extraReducers')
      invariant(Object.keys(extraReducers).every(key => !(key in reducers)),
        'app.start: extraReducers is conflict with other reducers'
      )

      const extraEnhancers = plugin.get('extraEnhancers')
      invariant(Array.isArray(extraEnhancers),
        'app.start: extraEnhancers should be array'
      )

      const extraMiddlewares = plugin.get('extraMiddlewares')
      const reducerEnhancer = plugin.get('onReducer')
      let middlewares = [
        ...flatten(extraMiddlewares)
      ]

      let composeEnhancers = compose
      if (process.env.node_env !== 'production') {
        if (typeof window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ === 'function') {
          composeEnhancers = window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__
        }
      }

      const enhancers = [
        applyMiddleware(...middlewares),
        ...extraEnhancers
      ]

      const store = this._store = createStore(
        createReducer(),
        initialState,
        composeEnhancers(...enhancers)
      )

      store.asyncReducers = {}
      store.unsubscribeHistory = browserHistory.listen(updateLocation(store))

      const listeners = plugin.get('onStateChange')
      for (const listener of listeners) {
        store.subscribe(() => listener(store.getState()))
      }

      const unlisteners = {}
      for (const model of this._models) {
        if (model.subscriptions) {
          unlisteners[model.namespace] = runSubscriptions(model.subscriptions, model, this, onErrorWrapper)
        }
      }

      this.model = injectModel.bind(this, createReducer, onErrorWrapper, unlisteners)
      this.unModel = unModel.bind(this, createReducer, reducers, unlisteners)
      this._getProvider = getProvider.bind(null, app._store, app)

      if (container) {
        render(container, store, this, this._router)
        plugin.apply('onHmr')(render.bind(this, container, store, this))
      } else {
        return getProvider(store, this, this._router)
      }

      function createReducer (asyncReducers) {
        return reducerEnhancer(combineReducers({
          ...reducers,
          ...extraReducers,
          ...asyncReducers
        }))
      }
    }

    function getProvider (store, app, router) {
      return props => (<Provider store={store}>
        {router({ app, history: app._history, ...props })}
      </Provider>)
    }

    function render (container, store, app, router) {
      const ReactDOM = require('react-dom')
      const Provider = getProvider(store, app, router)
      ReactDOM.render(<Provider />, container)
    }

    function isHTMLElement (node) {
      return typeof node === 'object' && node !== null && node.nodeType && node.nodeName
    }

    function getReducer (reducers, state) {
      if (Array.isArray(reducers)) {
        return reducers[1](handleActions(reducers[0], state))
      } else {
        return handleActions(reducers || {}, state)
      }
    }

    function runSubscriptions (subs, model, app, onError) {
      const unlisteners = []
      const noneFunctionSubscriptions = []

      for (const key in subs) {
        if (Object.prototype.hasOwnProperty.call(subs, key)) {
          const sub = subs[key]
          invariant(typeof sub === 'function', 'app.start: subscription should be function')

          const unlistener = sub({
            dispatch: createDispatch(app._store.dispatch, model),
            history: app._history
          }, onError)

          if (isFunction(unlisteners)) {
            unlisteners.push(unlistener)
          } else {
            noneFunctionSubscriptions.push(key)
          }
        }
      }

      return { unlisteners, noneFunctionSubscriptions }
    }

    function createDispatch (dispatch, model) {
      return (action) => {
        const { type } = action
        invariant(type, 'dispatch: action should be a plain Object with type')
        warning(type.indexOf(`${model.namespace}${SEP}`) !== 0,
          `dispatch: ${type} should not be prefixed with namespace ${model.namespace}`
        )

        return dispatch({ ...action, type: prefixType(type, model) })
      }
    }

    function prefixType (type, model) {
      const prefixedType = `${model.namespace}${SEP}${type}`
      if (model.reducers && model.reducers[prefixedType]) {
        return prefixedType
      }

      return type
    }

    function checkModel (m) {
      const model = { ...m }
      const { namespace, reducers } = model
      invariant(namespace, 'app.model: namespace should be defined')
      invariant(!app._models.some(model => model.namespace === namespace))
      // eslint-disable-next-line
      invariant(!reducers || isPlainObject(reducers) || Array.isArray(reducers),
        'app.model: reducers should be object or array'
      )
      invariant(!Array.isArray(reducers) || (isPlainObject(reducers[0]) && typeof reducers[1] === 'function'),
        'app.model: reducers with array should be app.model({ reducers: [object, function] })'
      )

      function applyNamespace (type) {
        function getNamespaceReducers (reducers) {
          return Object.keys(reducers).reduce((memo, key) => {
            warning(key.indexOf(`${namespace}${SEP}`) !== 0,
              `app.model: ${type.slice(0, -1)} ${key} should not be prefixed with namespace ${namespace}`
            )
            memo[`${namespace}${SEP}${key}`] = reducers[key]
            return memo
          }, {})
        }

        if (model[type]) {
          if (type === 'reducers' && Array.isArray(model[type])) {
            model[type][0] = getNamespacedReducers(model[type][0])
          } else {
            model[type] = getNamespacedReducers(model[type])
          }
        }
      }

      applyNamespace('reducers')

      return model
    }
  }
}

export default createIfox({
  initialReducer: {
    location
  },
  defaultHistory: browserHistory
})
