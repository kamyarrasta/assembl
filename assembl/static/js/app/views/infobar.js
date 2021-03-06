'use strict';

var Marionette = require('../shims/marionette.js'),
    Assembl = require('../app.js'),
    i18n = require("../utils/i18n.js"),
    Moment = require('moment'),
    CollectionManager = require('../common/collectionManager.js'),
    Widget = require('../models/widget.js'),
    Ctx = require('../common/context.js'),
    $ = require('../shims/jquery.js');


var InfobarItem = Marionette.LayoutView.extend({
  constructor: function InfobarItem() {
    Marionette.LayoutView.apply(this, arguments);
  },

  template: '#tmpl-infobar',
  className: 'content-infobar',
  events: {
    'click .js_closeInfobar': 'closeInfobar',
    'click .js_openSession': 'openSession',
    'click .js_openTargetInModal': 'openTargetInModal'
  },

  openTargetInModal: function(evt){
    return Ctx.openTargetInModal(evt);
  },

  serializeModel: function(model) {
    return {
      model: model,
      message: model.getDescriptionText(Widget.Model.prototype.INFO_BAR),
      call_to_action_msg: model.getLinkText(Widget.Model.prototype.INFO_BAR),
      share_link: model.getShareUrl(Widget.Model.prototype.INFO_BAR),
      widget_endpoint: model.getUrl(Widget.Model.prototype.INFO_BAR),
      call_to_action_class: model.getCssClasses(Widget.Model.prototype.INFO_BAR),
      locale: Ctx.getLocale()
    };
  },

  closeInfobar: function() {
    this.model.set("closeInfobar", true);
    Assembl.vent.trigger('infobar:closeItem');
    //this.options.parentPanel.adjustInfobarSize();
  }
});

var Infobars = Marionette.CollectionView.extend({
  constructor: function Infobars() {
    Marionette.CollectionView.apply(this, arguments);
  },

  childView: InfobarItem,
  initialize: function(options) {
    this.childViewOptions = {
      parentPanel: this
    };
    this.adjustInfobarSize();
  },
  collectionEvents: {
    "add remove reset change": "adjustInfobarSize"
  },
  adjustInfobarSize: function() {
    var el = Assembl.groupContainer.$el;
    var n = this.collection.length;

    for (var i = n - 2; i <= n + 2; i++) {
      if (i === n) {
        el.addClass("hasInfobar-" + String(i));
      } else {
        el.removeClass("hasInfobar-" + String(i));
      }
    }
  }
});


module.exports = Infobars;
