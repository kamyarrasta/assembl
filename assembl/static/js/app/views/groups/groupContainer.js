'use strict';

var Marionette = require('../../shims/marionette.js'),
    Assembl = require('../../app.js'),
    GroupContent = require('./groupContent.js'),
    AssemblPanel = require('../assemblPanel.js'),
    Notification = require('../notification.js'),
    PanelSpecTypes = require('../../utils/panelSpecTypes.js');

/**
 * Manages all the groups in the interface, essentially the GroupSpec.Collection
 * Normally referenced with Assembl.groupContainer
 */
var groupContainer = Marionette.CollectionView.extend({
  className: 'groupsContainer',
  childView: GroupContent,
  group_borders_size: 0,
  resizeSuspended: false,
  initialize: function(options) {
    var that = this;

    // boilerplate in marionette if you listen m/c here, use collectionEvents or modelEvents
    //this.listenTo(this.collection, 'change reset add remove', this.adjustGridSize);

  },

  /*
   * @param view A view (such as a messageList) for
   * which we want the matching groupContent to send events or manipulate
   * state.
   *
   * @return: A groupContent view
   */
  getGroupContent: function(view) {
    console.log("getGroupContent(): WRITEME!")
  },

  /* NOT YET TESTED - benoitg- 2015-06-29
   * @param viewClass A view (such as a messageList) for
   * which we want the matching groupContent to send events or manipulate
   * state.
   * @return Possibly empty array of panels
   */
  findGroupsWithPanelInstance: function(panelSpecType) {
    if (!panelSpecType)
        panelSpecType = PanelSpecTypes.MESSAGE_LIST;
    var groups = [];
    var group = this.children.each(function(group) {
          var requested_panel = group.findViewByType(panelSpecType);
          if (requested_panel) {
            groups.push(group);
          }
        });
    return groups;
  },

  childViewOptions: function(child, index) {
    return {
      groupContainer: this
    }
  },

  onAttach: function() {
      //console.log("groupContainer:  onAttach");
      this.resizeAllPanels();
    },

  onRender: function() {
      if (window.localStorage.getItem('showNotification')) {
        this.$el.addClass('hasNotification');
        Assembl.notificationRegion.show(new Notification());
      }
    },

  collectionEvents: {
    'reset add remove': 'adjustGridSize'
  },
  adjustGridSize: function() {
    var that = this;
    if (!this.resizeSuspended) {
      window.setTimeout(function() {
        that.resizeAllPanels();
      });
    }
  },
  suspendResize: function() {
    this.useCurrentSize();
    this.resizeSuspended = true;
  },
  resumeResize: function(skip_animation) {
    this.resizeSuspended = false;
    this.resizeAllPanels(skip_animation);
  },
  /** Does this group have exactly one navigation panel?
  * 
  */
  isOneNavigationGroup: function() {
    if (this.collection.size() == 1) {
      var group1 = this.collection.first();
      var panel_types = group1.get('panels').pluck('type');
      if (panel_types.length == 3
          && (PanelSpecTypes.getByRawId(panel_types[0]) === PanelSpecTypes.NAV_SIDEBAR
              || PanelSpecTypes.getByRawId(panel_types[0]) === PanelSpecTypes.TABLE_OF_IDEAS)

              //I don't think this code is correct anymore.   Why do we check that
              //there is an idea panel followed by a messagelist? benoitg- 2015-05-27
          && PanelSpecTypes.getByRawId(panel_types[1]) === PanelSpecTypes.IDEA_PANEL
          && PanelSpecTypes.getByRawId(panel_types[2]) === PanelSpecTypes.MESSAGE_LIST)
          return true;
    }

    return false;
  },

  resizeAllPanels: function(skip_animation) {
    //console.trace();
    // pixels from borders, or minimized panels except (boolean) those counted below.
    var extra_pixels = this.getExtraPixels(false); // global
    if (isNaN(extra_pixels))
        console.log("error in extra_pixels");
    var min_idea_pixels = this.getMinIdeaPixels(); // minimized idea panels that are absorbed by their message panel
    if (isNaN(min_idea_pixels))
        console.log("error in min_idea_pixels");
    var num_units = this.getTotalGridSize(); // global
    if (isNaN(num_units))
        console.log("error in num_units");
    this.useCurrentSize(); // get current sizes and override min/% with current size
    var total_min_size = this.calculateMinWidth();
    if (isNaN(total_min_size))
        console.log("error in total_min_size");

    //var total_pixel_size = total_min_size + extra_pixels + min_idea_pixels;
        
    var total_pixels = null;
    if (this.$el.parent() && this.$el.parent().attr("id") == "groupContainer") { // is it the main groupContainer or an inner one? (case of a popin)
      //console.log("we are in the main groupContainer case");
      total_pixels = window.innerWidth;
    } else {
      //console.log("we are in the inner groupContainer case");
      total_pixels = this.$el.parent() && this.$el.parent().width();
    }

    var unit_pixels = (total_pixels - extra_pixels) / num_units;

    // console.log("window_width:", window_width);
    // console.log("total_pixel_size:", total_pixel_size);
    // console.log("total_min_size:", total_min_size, "extra_pixels:", extra_pixels, "min_idea_pixels:", min_idea_pixels);
    // console.log("num_units:", num_units);
    // console.log("unit_pixels", unit_pixels);
    this.animateTowardsPixels(unit_pixels, 100.0 / num_units, extra_pixels, num_units, total_pixels, skip_animation); // reestablish min_pixels, and % width based on param. (remove size)
  },

  getExtraPixels: function(include_embedded_idea_panel) {
    var extraPixels = 0,
        that = this;
    this.children.each(function(groupContent) {
      extraPixels += that.group_borders_size + groupContent.getExtraPixels(include_embedded_idea_panel);
    });
    return extraPixels;
  },

  getMinIdeaPixels: function() {
    if (this.isOneNavigationGroup()) {
      if (this.collection.first().getPanelSpecByType(PanelSpecTypes.IDEA_PANEL).get('minimized')) {
        return AssemblPanel.prototype.minimized_size;
      }
    }

    return 0;
  },

  getTotalGridSize: function() {
    var gridSize = 0,
        that = this;
    this.children.each(function(child) {
      gridSize += child.calculateGridSize();
    });
    return gridSize;
  },

  useCurrentSize: function() {
    this.children.each(function(child) {
      child.useCurrentSize();
    });
  },

  calculateMinWidth: function() {
    var min_width = 0,
        that = this;
    this.children.each(function(child) {
      min_width += child.calculateMinWidth();
    });
    return min_width;
  },

  animateTowardsPixels: function(pixels_per_unit, percent_per_unit, extra_pixels, num_units, total_pixels, skip_animation) {
    this.children.each(function(child) {
      child.animateTowardsPixels(pixels_per_unit, percent_per_unit, extra_pixels, num_units, total_pixels, skip_animation);
    });
  }

});

module.exports = groupContainer;
